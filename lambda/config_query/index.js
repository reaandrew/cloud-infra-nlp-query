const AWS = require('aws-sdk');
const config = new AWS.Config();

exports.handler = async (event) => {
    try {
        // Parse the incoming event
        const body = JSON.parse(event.body);
        const { query } = body;

        if (!query) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Query parameter is required' })
            };
        }

        // Execute the Config query
        const params = {
            Expression: query,
            Limit: 100 // Adjust as needed
        };

        const response = await config.selectResourceConfig(params).promise();

        // Format the response
        const results = response.Results.map(result => {
            try {
                return JSON.parse(result);
            } catch (e) {
                return result;
            }
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                query,
                results,
                count: results.length
            })
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to execute query',
                message: error.message
            })
        };
    }
}; 