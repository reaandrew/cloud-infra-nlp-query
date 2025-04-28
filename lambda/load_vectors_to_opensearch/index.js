const AWS = require('aws-sdk');
const { Client } = require('@opensearch-project/opensearch');
const { AwsSigv4Signer } = require('@opensearch-project/opensearch/aws');

const s3 = new AWS.S3();
const secretsManager = new AWS.SecretsManager({ region: process.env.REGION });
const REGION = process.env.REGION;
const OPENSEARCH_DOMAIN = process.env.OPENSEARCH_DOMAIN;
const OPENSEARCH_INDEX = process.env.OPENSEARCH_INDEX || 'config-vectors';
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
let client;

/**
 * Initializes the OpenSearch index if it doesn't exist
 */
async function ensureIndexExists() {
  try {
    const exists = await client.indices.exists({
      index: OPENSEARCH_INDEX
    });
    
    if (!exists.body) {
      console.log(`Creating index ${OPENSEARCH_INDEX}`);
      await client.indices.create({
        index: OPENSEARCH_INDEX,
        body: {
          settings: {
            index: {
              number_of_shards: 3,
              number_of_replicas: 1
            }
          },
          mappings: {
            properties: {
              embedding: {
                type: 'knn_vector',
                dimension: 1024, // Titan embedding vector dimension
                method: {
                  name: 'hnsw',
                  space_type: 'cosinesimil',
                  engine: 'nmslib',
                  parameters: {
                    ef_construction: 128,
                    m: 16
                  }
                }
              },
              text: { type: 'text' },
              source: { type: 'keyword' },
              resourceType: { type: 'keyword' },
              timestamp: { type: 'date' }
            }
          }
        }
      });
      console.log(`Index ${OPENSEARCH_INDEX} created successfully`);
    } else {
      console.log(`Index ${OPENSEARCH_INDEX} already exists`);
    }
  } catch (error) {
    console.error('Error ensuring index exists:', error);
    throw error;
  }
}

/**
 * Loads a vector embedding document from S3 into OpenSearch
 */
async function loadVectorToOpenSearch(bucket, key) {
  try {
    console.log(`Processing ${key} from bucket ${bucket}`);
    
    // Get vector file from S3
    const response = await s3.getObject({ 
      Bucket: bucket, 
      Key: key 
    }).promise();
    
    const data = JSON.parse(response.Body.toString('utf-8'));
    
    console.log(`Data object keys: ${Object.keys(data).join(', ')}`);
    
    // If we have embedding field directly
    if (data.embedding) {
      console.log(`Found embedding with length: ${data.embedding.length}`);
      
      // Ensure embedding is an array of numbers
      if (!Array.isArray(data.embedding)) {
        console.warn(`Embedding is not an array: ${typeof data.embedding}`);
        return;
      }
      
      // Construct document to index
      const document = {
        vector: data.embedding,  // Using vector to match the OpenSearch knn_vector field
        embedding: data.embedding,  // Keep the original embedding too
        text: data.original ? JSON.stringify(data.original) : '',
        source: key,
        resourceType: data.original && data.original.resourceType ? data.original.resourceType : 'unknown',
        timestamp: new Date().toISOString()
      };
      
      console.log(`Embedding field type: ${typeof document.embedding}, isArray: ${Array.isArray(document.embedding)}, length: ${document.embedding.length}, first element: ${document.embedding[0]}`);
      
      // Index the document
      const documentId = key.replace(/[^a-zA-Z0-9]/g, '_');
      const indexResponse = await client.index({
        index: OPENSEARCH_INDEX,
        id: documentId,
        body: document,
        refresh: true // Immediately make the document available for search
      });
      
      console.log(`Document indexed with ID ${documentId}, response:`, indexResponse);
      return indexResponse;
    }
    
    console.warn(`No embedding found in ${key}, showing sample of data: ${JSON.stringify(data).substring(0, 500)}...`);
    return;
  } catch (error) {
    console.error(`Error loading vector from ${bucket}/${key} to OpenSearch:`, error);
    throw error;
  }
}

/**
 * Lambda handler function
 */
exports.handler = async (event) => {
  try {
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    // Get OpenSearch credentials from Secrets Manager
    const credentials = await getOpenSearchCredentials();
    
    // Create OpenSearch client with basic authentication
    client = new Client({
      node: `https://${OPENSEARCH_DOMAIN}`,
      auth: {
        username: credentials.username,
        password: credentials.password
      },
      ssl: {
        rejectUnauthorized: true
      }
    });
    
    // Ensure OpenSearch index exists
    await ensureIndexExists();
    
    // Process each S3 event record
    for (const record of event.Records) {
      if (record.eventName.startsWith('ObjectCreated:')) {
        const bucket = record.s3.bucket.name;
        const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
        
        await loadVectorToOpenSearch(bucket, key);
      }
    }
    
    return {
      statusCode: 200,
      body: `Successfully processed ${event.Records.length} records`
    };
  } catch (error) {
    console.error('Error in Lambda handler:', error);
    return {
      statusCode: 500,
      body: `Error processing vectors: ${error.message}`
    };
  }
};