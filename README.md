# traffic-snoop
Node function for analyzing traffic patterns between various home and work scenarios. This script is designed to be run as
an AWS Lambda functions on cron (eg. to measure what the traffic is like at specific times of day). It may also be run locally though after a brief setup.

For example, this script can be used to analyze commutes during rush hour between multiple locations.

## how to use
Pre-requisites:

1. Google Maps API key
2. AWS DynamoDB table
3. List of home and work addresses that you would like to analyze traffic between.

Create `./config.json` and fill in the following data:

```json
{
	"google": {
		"key": "your google api key here"
	},
	"aws": {
		"table": "dynamoDB table to record results to here"
	},
	"locations": {
		"work": ["array of work address strings"],
		"home": ["array of home address strings"]
	}
}
```

Create `./auth.json` with your AWS credentials needed to access the DynamoDB instance(this is the standard AWS SDK auth.json):

```json
{
	"accessKeyId": "<your access key>",
	"secretAccessKey": "<your secret key>",
	"region": "us-east-1"
}
```

Now you can run the script!

`$ node traffic.js`

You may also use a remote `config.json` by specifying a URL via `REMOTE_CONFIG` env var:

`$ REMOTE_CONFIG="http://your.web.host/config.json" node traffic.js`

The results for each run-through will accumulate into the specified DynamoDB table in the following format:

```json
{
	"uuid": "uuidv1",
	"origin": "origin address",
	"destination": "destination address",
	"travelTime": "10 minutes",
	"commute": "home -> work",
	"date": "YYYY/MM/DD",
	"day": "Wed",
	"time": "3:04 PM",
	"timestamp": "unix epoch in seconds"
}
```