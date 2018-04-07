// traffic.js by Matt Stills <mattacular@gmail.com>
//
// - measure travel time between each work and home location listed in
//   config.json
// - record each result to aws dynamoDB table
// - designed to run as an aws lambda function
//
// note: the complimentary google API limit is 2500 per day
// note: lambda functions are limited to 300 second runtime. when running
// as a lambda func, it is recommended that you limit the locations to 15
// to ensure the request can complete for each scenario.
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
const GOOGLE_API_ENDPOINT = "https://maps.googleapis.com/maps/api/distancematrix/json";

if (!isLambda) {
    console.log('Detected local environment. Loading AWS config...');
    AWS.config.loadFromPath('./auth.json');
} else {
    console.log('Detected AWS Lambda environment.');
}

function getDistanceRequest(origin, destination) {
    let params = {
        units: 'imperial',
        mode: 'driving',
        key: GOOGLE_API_KEY,
        language: 'en-EN'
    };

    params.origins = origin.replace(/\s/g, '+');
    params.destinations = destination.replace(/\s/g, '+');

    let request = GOOGLE_API_ENDPOINT + (() => {
        let i = 0,
            retVal = '';

        Object.keys(params).forEach((key) => {
            retVal += (i++ === 0 ? '?' : '&') + key + '=' + params[key];
        });

        return retVal;
    })();

    return request;
}

async function processRoutes() {
    let originKey, apiRequest, queue = [];

    // check whether it is morning or afternoon to determine route direction
    if (DateTime.local().setZone('UTC-4').toFormat('a').toLowerCase() === 'pm') {
        // if afternoon, going from work -> home
        originKey = 'work';
    } else {
        originKey = 'home';
    }

    // gather the requests (locations.work.length * locations.home.length)
    locations.work.forEach((workAddress) => {
        locations.home.forEach((homeAddress) => {
            apiRequest = (originKey === 'home') ? getDistanceRequest(homeAddress, workAddress)
                                                : getDistanceRequest(workAddress, homeAddress);
            queue.push(axios.get(apiRequest));
        });
    });

    // gather the responses
    let times = [];

    (await Promise.all(queue)).forEach((response) => {
        if (response.status === 200 &&
            response.data &&
            response.data.status === 'OK' &&
            response.data.rows) {

            times.push(response.data.rows[0].elements[0].duration.text);
        }
    });

    return times;
}

// write results from the Google Maps API to our DynamoDB table for later analysis
async function writeResults(results) {
    let ddb = new AWS.DynamoDB({apiVersion: '2012-08-10'}),
        meridiem = DateTime.local().setZone('UTC-4').toFormat('a').toLowerCase(),
        requestItems,
        i = 0;

    requestItems = results.map((result) => {
        console.log('# processing item ->', result);
        return {
            PutRequest: {
                Item: {
                    // each item has a unique, timestamp-based uuid
                    uuid: { 'S' : uuidv1() },
                        // our travel data
                        origin: { 'S': 'Test Origin' },
                        destination: { 'S': 'Test Destination' },
                        travelTime: { 'S': result },
                        // item metadata
                        date: { 'S': '2018/04/07' },
                        timeOfDay: { 'S': meridiem },
                        timestamp: { 'N': Math.round(+new Date() / 1000).toString() }
                },
            },
        };
    });

    ddb.batchWriteItem({
        RequestItems: {
            [AWS_DYNAMO_DB_TABLE]: requestItems
        },
    }, (err, data) => {
        if (err) {
            console.log("Error", err);
        } else {
            console.log("Success", data);
        }
    });
}

// kick us off
(async function main() {
    let times = await processRoutes();

    console.log('Got result times,');
    console.log(times);
    console.log('Writing to database....');

    writeResults(times);
}());