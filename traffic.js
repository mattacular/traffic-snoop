/**
 *  traffic.js by Matt Stills <mattacular@gmail.com>
 *
 *  - measure (driving) travel time between each "work" and "home" location
 *    listed in config.json
 *  - record each result to aws dynamoDB table for later analysis
 *  - designed to run as an aws lambda rate/cron function
 *
 *  note: the complimentary google API limit is 2,500 per day
 *
 *  note: lambda functions are limited to 300 second runtime. when running
 *  with lambda, it is recommended that you limit the total number of comparisons
 *  (home locations * work locations) to ~15-20 in order ensure the entire job can
 *  complete in the allotted time.
 */
const { DateTime } = require('luxon');
const uuidv1 = require('uuid/v1');
const axios = require('axios');
const AWS = require('aws-sdk');
const isLambda = require('is-lambda');
const fs = require('fs');
const GOOGLE_API_ENDPOINT = 'https://maps.googleapis.com/maps/api/distancematrix/json';

var config;
var results;

// helper that returns a fully-formed Google Maps API request URL
function getDistanceRequest(origin, destination) {
    let params = {
        units: 'imperial',
        mode: 'driving',
        key: config.google.key,
        language: 'en-EN',
        departure_time: 'now'
    };

    params.origins = origin.replace(/\s/g, '+');
    params.destinations = destination.replace(/\s/g, '+');

    let queryParams = (() => {
        let i = 0, retVal = '';

        Object.keys(params).forEach((key) => {
            retVal += (i++ === 0 ? '?' : '&') + key + '=' + params[key];
        });

        return retVal;
    })();

    return GOOGLE_API_ENDPOINT + queryParams;
}

// make HTTP request(s) to the Google API and gather results object
async function getResults() {
    let queue = [], originKey, apiRequest, direction;

    // validate the provided configuration
    if (!config.locations.work.length ||
        !config.locations.home.length) {

        throw new Error(
            'Could not find location pair to measure.',
            'Ensure you have provided at least one of each location of each type.'
        );
    }

    if (config.locations.work.length * config.locations.home.length > 20) {
        throw new Error(
            'Exceeded permutations limit.',
            'Please reduce the number of locations.'
        );
    }

    // check whether it is morning or afternoon to determine route direction
    if (DateTime.local().setZone('UTC-4').toFormat('a').toLowerCase() === 'pm') {
        // if afternoon, going from work -> home
        originKey = 'work';
        direction = 'work->home';
    } else {
        originKey = 'home';
        direction = 'home->work';
    }

    // gather the request URLs for each commute scenario
    // #(locations.work.length * locations.home.length)
    config.locations.work.forEach((workAddress) => {
        config.locations.home.forEach((homeAddress) => {
            apiRequest = (originKey === 'home') ? getDistanceRequest(homeAddress, workAddress)
                                                : getDistanceRequest(workAddress, homeAddress);
            queue.push(axios.get(apiRequest));
        });
    });

    // gather back the responses
    let responses = [];

    (await Promise.all(queue)).forEach((response) => {
        if (response.status === 200 &&
            response.data &&
            response.data.status === 'OK' &&
            response.data.rows) {

            responses.push({
                origin: response.data.origin_addresses[0],
                destination: response.data.destination_addresses[0],
                travelTime: response.data.rows[0].elements[0].duration.text
            });
        }
    });

    return responses;
}

// write results from the Google Maps API to our DynamoDB table for later analysis
async function writeResults(results) {
    let ddb = new AWS.DynamoDB({apiVersion: '2012-08-10'}),
        timestamp = Math.round(+new Date() / 1000).toString(),
        now = DateTime.local().setZone('UTC-4'),
        dateFormat = now.toFormat('yyyy/MM/dd'),
        dayFormat = now.toFormat('ccc'),
        timeFormat = now.toFormat('t'),
        meridiem = now.toFormat('a').toLowerCase(),
        commuteLabel = (meridiem === 'am') ? 'home -> work' : 'work -> home',
        requestItems,
        i = 0;

    // create batch of results to write to db
    requestItems = results.map((result) => {
        return {
            'PutRequest': {
                'Item': {
                    // each item has a unique, timestamp-based uuid
                    'uuid': { 'S' : uuidv1() },
                        'origin': { 'S': result.origin },
                        'destination': { 'S': result.destination },
                        'travelTime': { 'S': result.travelTime },
                        'commute': { 'S': commuteLabel },
                        'date': { 'S': dateFormat },
                        'day': { 'S': dayFormat },
                        'time': { 'S': timeFormat },
                        // convert ms -> s
                        'timestamp': { 'N': timestamp }
                },
            },
        };
    });

    ddb.batchWriteItem({
        'RequestItems': {
            [config.aws.table]: requestItems
        },
    }, (err, data) => {

        if (err) {
            console.error('Batch write error:', err);
        } else {
            !isLambda && console.log('Batch write was successful.');
        }
    });
}

// read in our config
async function getConfig() {
    let config, remoteRequest;

    if (process.env.REMOTE_CONFIG) {
        remoteRequest = await axios.get(process.env.REMOTE_CONFIG);

        if (remoteRequest.status === 200) {
            config = remoteRequest.data;
        } else {
            throw new Error('Could not retrieve remote config.json.');
        }
    } else {
        config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    }

    return config;
}

// detect whether we are running in an AWS Lambda environment
if (isLambda) {
    exports.handler = async () => {
        config = await getConfig();
        results = await getResults();
        writeResults(results);
    };
} else {
    // load credentials for local execution (lambda function is authorized via attached role)
    AWS.config.loadFromPath('./auth.json');

    // kick everything off with extra logging
    (async function main() {
        config = await getConfig();
        results = await getResults();

        console.log('Got result times,');
        console.log(results);
        console.log('Recording to database...');

        writeResults(results);

        console.log('Complete.');
    }());
}
