# traffic-snoop
Node function for analyzing traffic patterns between various home and work scenarios. This script is designed to be run as
an AWS Lambda functions on cron (eg. to measure what the traffic is like at specific times of day).

For example, this script can be used to analyze commutes during rush hour between multiple locations.

## how to use
1. get Google Maps API key
2. create dynamo DB
3. create a list of home and work addresses that you would like to analyze traffic between.

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
		"work": [array of work address strings]
		"home": [array of home address strings]
	}
}
```

Create `./auth.json` with your AWS credentials needed to access the DynamoDB instance(this is the standard AWS SDK auth.json):

```json
{
	"accessKeyId": ""
	"secretAccessKey": ""
	"region": ""
}
```

Now you can run the script!

`$ node traffic.js`