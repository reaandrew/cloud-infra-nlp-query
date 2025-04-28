const AWS = require('aws-sdk');
const { Client } = require('@opensearch-project/opensearch');
const { AwsSigv4Signer } = require('@opensearch-project/opensearch/aws');
const config = new AWS.Config();
const bedrock = new AWS.BedrockRuntime({ region: process.env.REGION });
const secretsManager = new AWS.SecretsManager({ region: process.env.REGION });

const REGION = process.env.REGION;
const OPENSEARCH_DOMAIN = process.env.OPENSEARCH_DOMAIN;
const OPENSEARCH_INDEX = process.env.OPENSEARCH_INDEX || 'config-vectors';
const TITAN_MODEL_ID = process.env.TITAN_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const OPENSEARCH_CREDS_SECRET = process.env.OPENSEARCH_CREDS_SECRET || 'config-vectors-opensearch-credentials';

// Function to get OpenSearch credentials from Secrets Manager
async function getOpenSearchCredentials() {
  try {
    const data = await secretsManager.getSecretValue({ SecretId: OPENSEARCH_CREDS_SECRET }).promise();
    if ('SecretString' in data) {
      return JSON.parse(data.SecretString);
    } else {
      throw new Error('Secret binary is not supported');
    }
  } catch (error) {
    console.error('Error retrieving OpenSearch credentials:', error);
    throw error;
  }
}

// Initialize OpenSearch client - will be set in the handler
let opensearchClient;

/**
 * Generate embeddings for a text using Amazon Titan
 */
async function generateEmbeddings(text) {
  try {
    const params = {
      modelId: TITAN_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: text
      })
    };

    const response = await bedrock.invokeModel(params).promise();
    const result = JSON.parse(Buffer.from(response.body).toString());
    
    return result.embedding;
  } catch (error) {
    console.error('Error generating embeddings:', error);
    throw error;
  }
}

/**
 * Search for similar vectors in OpenSearch
 */
async function searchVectors(vector, k = 5) {
  try {
    const response = await opensearchClient.search({
      index: OPENSEARCH_INDEX,
      body: {
        size: k,
        query: {
          knn: {
            vector: {
              vector: vector,
              k: k
            }
          }
        }
      }
    });

    return response.body.hits.hits.map(hit => ({
      score: hit._score,
      source: hit._source
    }));
  } catch (error) {
    console.error('Error searching vectors:', error);
    throw error;
  }
}

/**
 * Execute a raw AWS Config query
 */
async function executeConfigQuery(query) {
  try {
    const params = {
      Expression: query,
      Limit: 100 // Adjust as needed
    };

    const response = await config.selectResourceConfig(params).promise();

    // Format the response
    return response.Results.map(result => {
      try {
        return JSON.parse(result);
      } catch (e) {
        return result;
      }
    });
  } catch (error) {
    console.error('Error executing config query:', error);
    throw error;
  }
}

exports.handler = async (event) => {
  try {
    // Parse the incoming event
    const body = JSON.parse(event.body);
    const { query, queryType = 'nl' } = body;

    if (!query) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Query parameter is required' })
      };
    }
    
    // Get OpenSearch credentials and initialize client
    const credentials = await getOpenSearchCredentials();
    
    // Create OpenSearch client with basic authentication
    opensearchClient = new Client({
      node: `https://${OPENSEARCH_DOMAIN}`,
      auth: {
        username: credentials.username,
        password: credentials.password
      },
      ssl: {
        rejectUnauthorized: true
      }
    });

    // Handle different query types
    if (queryType === 'raw') {
      // Execute raw Config query
      const results = await executeConfigQuery(query);
      
      return {
        statusCode: 200,
        body: JSON.stringify({
          query,
          results,
          count: results.length
        })
      };
    } else if (queryType === 'nl') {
      // NLP-based vector search
      // 1. Generate embeddings for the query
      const queryVector = await generateEmbeddings(query);
      
      // 2. Search for similar vectors in OpenSearch
      const vectorResults = await searchVectors(queryVector);
      
      return {
        statusCode: 200,
        body: JSON.stringify({
          query,
          vectorResults,
          count: vectorResults.length
        })
      };
    } else {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid queryType. Must be "raw" or "nl"' })
      };
    }
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