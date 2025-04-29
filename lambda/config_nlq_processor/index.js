const AWS = require('aws-sdk');
const { Client } = require('@opensearch-project/opensearch');
const { AwsSigv4Signer } = require('@opensearch-project/opensearch/aws');
const bedrock = new AWS.BedrockRuntime({ region: process.env.REGION });
const secretsManager = new AWS.SecretsManager({ region: process.env.REGION });

const REGION = process.env.REGION || 'eu-west-2';
const OPENSEARCH_DOMAIN = process.env.OPENSEARCH_DOMAIN;
const OPENSEARCH_INDEX = process.env.OPENSEARCH_INDEX || 'config-vectors';
const TITAN_MODEL_ID = process.env.TITAN_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const CLAUDE_MODEL_ID = process.env.CLAUDE_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0';
const OPENSEARCH_CREDS_SECRET = process.env.OPENSEARCH_CREDS_SECRET || 'config-vectors-opensearch-credentials';
const RESULTS_LIMIT = process.env.RESULTS_LIMIT || 5;

// Get OpenSearch credentials from Secrets Manager
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

// Initialize OpenSearch client
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
async function searchVectors(vector, k = RESULTS_LIMIT) {
  try {
    const response = await opensearchClient.search({
      index: OPENSEARCH_INDEX,
      body: {
        size: k,
        query: {
          knn: {
            embedding: {
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
 * Analyze results with Claude to generate a human-friendly response
 */
async function analyzeWithClaude(query, searchResults) {
  try {
    // Prepare the resource data from search results
    const resourceData = searchResults.map(result => {
      let resourceInfo = {};
      
      try {
        // Extract original resource info if available
        if (result.source.text) {
          const originalText = result.source.text;
          // Try to parse the text which should be JSON stringified
          const resourceObj = JSON.parse(originalText);
          resourceInfo = {
            resourceType: resourceObj.resourceType || result.source.resourceType,
            properties: resourceObj.properties || {},
            // Include other relevant info
            similarity: result.score
          };
        } else {
          resourceInfo = {
            resourceType: result.source.resourceType,
            similarity: result.score
          };
        }
      } catch (e) {
        console.warn('Error parsing resource text:', e);
        resourceInfo = {
          resourceType: result.source.resourceType || 'unknown',
          text: result.source.text || 'No text available',
          similarity: result.score
        };
      }
      
      return resourceInfo;
    });

    // Prepare prompt for Claude
    const systemPrompt = `You are an AWS Config expert helper. Analyze the following AWS resources that were retrieved for the user's query.
Explain which specific AWS Config fields and properties would be used to answer their question.
Focus on providing a clear explanation of:
1. Which resource types are most relevant to the query
2. Which specific fields or properties would need to be accessed
3. How those fields relate to the user's question
4. A sample AWS Config query that could be used (if appropriate)

Keep your response concise, technical but accessible, and focused on AWS Config.`;

    const userMessage = `User Query: "${query}"

Here are the resources that seem most relevant based on semantic search (sorted by relevance):
${JSON.stringify(resourceData, null, 2)}

Please analyze these results and explain which fields would be used to answer the query.`;

    // Call Claude via Bedrock
    const params = {
      modelId: CLAUDE_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1000,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ]
      })
    };

    const response = await bedrock.invokeModel(params).promise();
    const result = JSON.parse(Buffer.from(response.body).toString());
    return result.content[0].text;
  } catch (error) {
    console.error('Error analyzing with Claude:', error);
    throw error;
  }
}

/**
 * Lambda handler for processing natural language queries
 */
exports.handler = async (event) => {
  try {
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    // Parse the request
    const body = JSON.parse(event.body || '{}');
    const query = body.query;
    const limit = body.limit || RESULTS_LIMIT;
    
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
    
    // Process the query
    console.log(`Processing NL query: ${query}`);
    
    // 1. Generate embeddings for the query
    const queryEmbedding = await generateEmbeddings(query);
    console.log(`Generated embedding with ${queryEmbedding.length} dimensions`);
    
    // 2. Search for similar vectors in OpenSearch
    const searchResults = await searchVectors(queryEmbedding, limit);
    console.log(`Found ${searchResults.length} relevant resources`);
    
    // 3. Analyze results with Claude
    const analysis = await analyzeWithClaude(query, searchResults);
    console.log('Generated analysis with Claude');
    
    // 4. Return the results
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query,
        analysis,
        relevantResources: searchResults.map(result => ({
          resourceType: result.source.resourceType,
          similarity: result.score
        }))
      })
    };
  } catch (error) {
    console.error('Error in Lambda handler:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to process query',
        message: error.message
      })
    };
  }
};