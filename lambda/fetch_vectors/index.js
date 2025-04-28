// Lambda function to fetch vectors from S3 events
// Logs events received from S3 for monitoring purposes

// Import AWS SDK
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client();

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
 * Lambda handler that processes S3 events from the chunks bucket
 * This function logs the event details and could be extended for vector processing
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
                // Get object metadata only to log information about the chunk
                const command = new GetObjectCommand({
                    Bucket: bucketName,
                    Key: objectKey
                });
                
                const response = await s3.send(command);
                
                // Log metadata
                console.log(`Chunk metadata:`, {
                    contentType: response.ContentType,
                    size: response.ContentLength,
                    lastModified: response.LastModified,
                    eTag: response.ETag
                });
                
                // Future expansion: Here you would process the chunks for vector embedding
                // This could include:
                // 1. Reading and parsing the JSON content
                // 2. Extracting text for embedding
                // 3. Calling an embedding service
                // 4. Storing the vectors in OpenSearch
                
                return {
                    bucketName,
                    objectKey,
                    status: 'processed'
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
        const processed = results.filter(r => r.status === 'processed').length;
        const failed = results.filter(r => r.status === 'error').length;
        
        console.log(`Processed ${processed} chunks, ${failed} failed`);
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                processed,
                failed,
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