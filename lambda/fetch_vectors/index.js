// Lambda function to fetch embeddings from Titan and store in S3
// Processes chunks from the chunks bucket and generates vector embeddings

// Import AWS SDK
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

// Initialize S3 and Bedrock clients
const s3 = new S3Client();
const bedrockRuntime = new BedrockRuntimeClient({ region: process.env.REGION });

// Constants from environment variables
const VECTORS_BUCKET = process.env.VECTORS_BUCKET || 'cinq-config-vectors';
const TITAN_MODEL_ID = process.env.TITAN_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const MAX_TOKEN_LENGTH = 8000; // Titan embedding model limit

// Helper function to convert stream to buffer
async function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

/**
 * Extracts text from a config resource object for embedding
 * Creates a comprehensive text representation of the resource
 */
function extractTextForEmbedding(resource) {
    // Special handling for AWS Config resources that have specific structure
    if (resource.resourceType) {
        const parts = [];
        
        // Add resource type and description if available
        parts.push(`Resource Type: ${resource.resourceType}`);
        
        if (resource.documentation) {
            parts.push(`Documentation: ${resource.documentation}`);
        }
        
        // Add properties information
        if (resource.properties) {
            parts.push('Properties:');
            
            Object.entries(resource.properties).forEach(([propName, propDetails]) => {
                let propText = `  - ${propName}`;
                
                if (propDetails.documentation) {
                    propText += `: ${propDetails.documentation}`;
                }
                
                if (propDetails.type) {
                    propText += ` (Type: ${propDetails.type})`;
                }
                
                if (propDetails.required) {
                    propText += ' (Required)';
                }
                
                parts.push(propText);
            });
        }
        
        // Add related properties if available
        if (resource.relatedProperties && Object.keys(resource.relatedProperties).length > 0) {
            parts.push('Related Properties:');
            
            Object.keys(resource.relatedProperties).forEach(propKey => {
                parts.push(`  - ${propKey}`);
            });
        }
        
        return parts.join('\n');
    } 
    
    // Generic approach for other types of resources
    return JSON.stringify(resource, null, 2);
}

/**
 * Truncates text to max token length compatible with embedding model
 * Simple approximation: 1 token ≈ 4 characters for English text
 */
function truncateText(text, maxTokens = MAX_TOKEN_LENGTH) {
    const approxCharsPerToken = 4;
    const maxChars = maxTokens * approxCharsPerToken;
    
    if (text.length <= maxChars) {
        return text;
    }
    
    console.warn(`Text exceeded max token length, truncating from ${text.length} chars to ${maxChars}`);
    return text.substring(0, maxChars);
}

/**
 * Gets embeddings from Titan model through Amazon Bedrock
 */
async function getEmbeddings(text) {
    try {
        // Prepare the request payload for Titan embedding model
        const payload = {
            inputText: truncateText(text)
        };
        
        // Invoke Bedrock with Titan embedding model
        const command = new InvokeModelCommand({
            modelId: TITAN_MODEL_ID,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify(payload)
        });
        
        console.log(`Requesting embeddings for text (${text.length} chars)`);
        const response = await bedrockRuntime.send(command);
        
        // Parse the response
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        
        if (!responseBody.embedding) {
            throw new Error('No embedding in response from Titan model');
        }
        
        console.log(`Received embedding vector of dimension ${responseBody.embedding.length}`);
        return responseBody.embedding;
    } catch (error) {
        console.error('Error getting embeddings from Titan:', error);
        throw error;
    }
}

/**
 * Processes a chunk from S3, extracts text, gets embeddings, and stores the result
 */
async function processChunk(bucketName, objectKey) {
    // Get the chunk content
    const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: objectKey
    });
    
    const response = await s3.send(getCommand);
    const contentBuffer = await streamToBuffer(response.Body);
    const chunkData = JSON.parse(contentBuffer.toString('utf-8'));
    
    console.log(`Processing chunk: ${objectKey}, content type: ${typeof chunkData}`);
    
    // Determine if this is a single resource or multiple resources
    if (Array.isArray(chunkData)) {
        console.log(`Processing array of ${chunkData.length} items`);
        
        // Process each item in the array individually
        const results = await Promise.all(chunkData.map(async (item, index) => {
            const text = extractTextForEmbedding(item);
            const embedding = await getEmbeddings(text);
            
            // Create a vector document with the embedding and original data
            const vectorDocument = {
                metadata: {
                    source: objectKey,
                    index: index,
                    timestamp: new Date().toISOString()
                },
                original: item,
                embedding
            };
            
            // Store the vector document
            const objectId = item.id || item.resourceType || `item_${index}`;
            const vectorKey = `${objectKey.replace(/^chunks\//, '')}_${objectId.replace(/:/g, '_')}.json`;
            
            await storeVectorDocument(vectorKey, vectorDocument);
            
            return { objectId, vectorKey };
        }));
        
        return {
            count: results.length,
            items: results
        };
    } else {
        // Process a single resource
        console.log(`Processing single resource object`);
        const text = extractTextForEmbedding(chunkData);
        const embedding = await getEmbeddings(text);
        
        // Create a vector document
        const objectId = chunkData.id || chunkData.resourceType || 'resource';
        const vectorDocument = {
            metadata: {
                source: objectKey,
                timestamp: new Date().toISOString()
            },
            original: chunkData,
            embedding
        };
        
        // Store the vector document
        const vectorKey = `${objectKey.replace(/^chunks\//, '')}_${objectId.replace(/:/g, '_')}.json`;
        await storeVectorDocument(vectorKey, vectorDocument);
        
        return {
            count: 1,
            items: [{ objectId, vectorKey }]
        };
    }
}

/**
 * Stores a vector document in the vectors bucket
 */
async function storeVectorDocument(key, document) {
    const putCommand = new PutObjectCommand({
        Bucket: VECTORS_BUCKET,
        Key: key,
        Body: JSON.stringify(document, null, 2),
        ContentType: 'application/json'
    });
    
    await s3.send(putCommand);
    console.log(`Stored vector document: ${key}`);
}

/**
 * Lambda handler that processes S3 events from the chunks bucket
 * Generates embeddings for chunks and stores them in the vectors bucket
 */
exports.handler = async (event) => {
    console.log('Received S3 event:', JSON.stringify(event, null, 2));
    
    try {
        if (!event.Records || event.Records.length === 0) {
            console.error('No records found in event');
            return { statusCode: 400, body: 'No records in event.' };
        }
        
        // Process each record in the event
        const results = await Promise.all(event.Records.map(async (record) => {
            const bucketName = record.s3.bucket.name;
            const objectKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
            
            console.log(`Processing chunk from s3://${bucketName}/${objectKey}`);
            
            try {
                const processingResult = await processChunk(bucketName, objectKey);
                
                return {
                    bucketName,
                    objectKey,
                    status: 'processed',
                    count: processingResult.count
                };
            } catch (error) {
                console.error(`Error processing ${objectKey}:`, error);
                return {
                    bucketName,
                    objectKey,
                    status: 'error',
                    error: error.message
                };
            }
        }));
        
        // Summarize results
        const processed = results.filter(r => r.status === 'processed');
        const processedCount = processed.reduce((sum, r) => sum + (r.count || 0), 0);
        const failedCount = results.filter(r => r.status === 'error').length;
        
        console.log(`Generated embeddings for ${processedCount} resources, ${failedCount} failed chunks`);
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                processed: processedCount,
                failed: failedCount,
                totalRecords: event.Records.length
            })
        };
        
    } catch (error) {
        console.error('Error processing event:', error);
        return { 
            statusCode: 500, 
            body: `Error processing event: ${error.message}`
        };
    }
};