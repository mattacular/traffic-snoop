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
// libraries
const { DateTime } = require('luxon');
const uuidv1 = require('uuid/v1');
const axios = require('axios');
const AWS = require('aws-sdk');
const isLambda = require('is-lambda');
const fs = require('fs');

// read in our config
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const GOOGLE_API_KEY = config.google.key;
const AWS_DYNAMO_DB_TABLE = config.aws.table;
const locations = config.locations;
const GOOGLE_API_ENDPOINT = 'https://maps.googleapis.com/maps/api/distancematrix/json';

if (!isLambda) {
    console.log('Detected local environment. Loading AWS config...');
    AWS.config.loadFromPath('./auth.json');
}

// helper that returns a fully-formed Google Maps API request URL
function getDistanceRequest(origin, destination) {
    let params = {
        units: 'imperial',
        mode: 'driving',
        key: GOOGLE_API_KEY,
        language: 'en-EN'
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
async function processRoutes() {
    let originKey, apiRequest, direction, queue = [];

    // validate the provided configuration
    if (!locations.work.length ||
        !locations.home.length) {

        throw new Error(
            'Could not find location pair to measure.',
            'Ensure you have provided at least one of each location of each type.'
        );
    }

    if (locations.work.length * locations.home.length > 20) {
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
    locations.work.forEach((workAddress) => {
        locations.home.forEach((homeAddress) => {
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
        meridiem = now.toFormat('a').toLowerCase(),
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
                        'commute': { 'S': (meridiem === 'AM') ? 'home->work' : 'work->home' },
                        'date': { 'S': dateFormat },
                        // convert to seconds
                        'timestamp': { 'N': timestamp }
                },
            },
        };
    });

    ddb.batchWriteItem({
        'RequestItems': {
            [AWS_DYNAMO_DB_TABLE]: requestItems
        },
    }, (err, data) => {

        if (err) {
            console.error('Batch write error:', err);
        } else {
            !isLambda && console.log('Batch write was successful.');
        }
    });
}

if (isLambda) {
    exports.handler = async () => {
        let results = await processRoutes();
        writeResults(results);
    };
} else {
    // kick everything off
    (async function main() {
        let results = await processRoutes();

        console.log('Got result times,');
        console.log(results);
        console.log('Recording to database...');

        writeResults(results);

        console.log('Complete.');
    }());
}
