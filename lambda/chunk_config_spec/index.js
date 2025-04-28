const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
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

// Target bucket for chunks
const CHUNKS_BUCKET = process.env.CHUNKS_BUCKET;
const CHUNK_SIZE = 100; // Number of items per chunk (customize as needed)

exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    // Initialize counter at the top level so it's available in all code paths
    let totalChunks = 0;
    
    try {
        if (!event.Records || event.Records.length === 0) {
            console.error('No records found in event');
            return { statusCode: 400, body: 'No records in event.' };
        }
        
        const record = event.Records[0];
        console.log('Processing record:', JSON.stringify(record, null, 2));
        
        const srcBucket = record.s3.bucket.name;
        const srcKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
        console.log(`Processing file from s3://${srcBucket}/${srcKey}`);

        // Get the file from S3
        const command = new GetObjectCommand({ Bucket: srcBucket, Key: srcKey });
        const response = await s3.send(command);
        const streamToString = await streamToBuffer(response.Body);
        const json = JSON.parse(streamToString.toString('utf-8'));

        // Process ResourceTypes specifically for Config resources - optimized for vector search
        if (json.ResourceTypes) {
            // Store each resource type as a separate document with its properties 
            // This creates semantically coherent chunks ideal for vector similarity search
            const resourceTypes = Object.entries(json.ResourceTypes);
            
            console.log(`Processing ${resourceTypes.length} resource types for vector search`);
            
            // Create individual documents for each resource type
            for (const [resourceType, resourceSpec] of resourceTypes) {
                // Create a document with resource type metadata and enriched description
                const chunk = {
                    id: resourceType,
                    resourceType,
                    ...resourceSpec,
                    // Find relevant property types for this resource (if available)
                    relatedProperties: {}
                };
                
                // Add related property types to make the semantic chunk more complete
                if (json.PropertyTypes) {
                    // Find property types that are part of this resource type by name prefix (e.g., AWS::EC2::Instance.*)
                    const relatedProps = Object.entries(json.PropertyTypes)
                        .filter(([key]) => key.startsWith(`${resourceType}.`));
                    
                    if (relatedProps.length > 0) {
                        chunk.relatedProperties = Object.fromEntries(relatedProps);
                    }
                }
                
                // Store in chunks directory
                const normalizedTypeName = resourceType.replace(/:/g, '_');
                const chunkKey = `chunks/${normalizedTypeName}.json`;
                
                const putCommand = new PutObjectCommand({
                    Bucket: CHUNKS_BUCKET,
                    Key: chunkKey,
                    Body: JSON.stringify(chunk, null, 2),
                    ContentType: 'application/json'
                });
                
                await s3.send(putCommand);
                totalChunks++;
            }
            
            // No need for a separate index file
            
            console.log(`Created ${resourceTypes.length} semantic vector documents for resources`);
            
            // For property types, we'll create a combined index rather than individual files
            // as they're typically less useful on their own but valuable in context
            if (json.PropertyTypes) {
                // Group property types by parent resource type
                const propertyTypesByResource = {};
                Object.entries(json.PropertyTypes).forEach(([key, value]) => {
                    // Keys are formatted like "AWS::EC2::Instance.BlockDeviceMapping"
                    const parts = key.split('.');
                    const resourceType = parts[0]; // Just the resource type prefix
                    
                    if (!propertyTypesByResource[resourceType]) {
                        propertyTypesByResource[resourceType] = {};
                    }
                    propertyTypesByResource[resourceType][key] = value;
                });
                
                // Create one file per resource type for its property types
                for (const [resourceType, properties] of Object.entries(propertyTypesByResource)) {
                    const normalizedTypeName = resourceType.replace(/:/g, '_');
                    const propertyTypeKey = `chunks/${normalizedTypeName}_properties.json`;
                    
                    const putCommand = new PutObjectCommand({
                        Bucket: CHUNKS_BUCKET,
                        Key: propertyTypeKey,
                        Body: JSON.stringify(properties, null, 2),
                        ContentType: 'application/json'
                    });
                    
                    await s3.send(putCommand);
                    totalChunks++;
                }
            }
        } else {
            // Simple chunking for other formats
            console.log('Processing generic data for chunking');
            
            // Set a reasonable chunk size
            const CHUNK_SIZE = 20;
            
            if (Array.isArray(json)) {
                // For arrays, chunk the array items
                for (let i = 0; i < json.length; i += CHUNK_SIZE) {
                    const chunk = json.slice(i, i + CHUNK_SIZE);
                    const chunkNum = Math.floor(i / CHUNK_SIZE);
                    const chunkKey = `chunks/${srcKey.replace(/\//g, '_')}_chunk_${chunkNum}.json`;
                    
                    const putCommand = new PutObjectCommand({
                        Bucket: CHUNKS_BUCKET,
                        Key: chunkKey,
                        Body: JSON.stringify(chunk, null, 2),
                        ContentType: 'application/json'
                    });
                    await s3.send(putCommand);
                    totalChunks++;
                }
            } else {
                // For objects, chunk by keys
                const entries = Object.entries(json);
                for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
                    const chunk = Object.fromEntries(entries.slice(i, i + CHUNK_SIZE));
                    const chunkNum = Math.floor(i / CHUNK_SIZE);
                    const chunkKey = `chunks/${srcKey.replace(/\//g, '_')}_chunk_${chunkNum}.json`;
                    
                    const putCommand = new PutObjectCommand({
                        Bucket: CHUNKS_BUCKET,
                        Key: chunkKey,
                        Body: JSON.stringify(chunk, null, 2),
                        ContentType: 'application/json'
                    });
                    await s3.send(putCommand);
                    totalChunks++;
                }
            }
            
            console.log(`Processed data into ${totalChunks} chunks`);
        }
        
        const result = { statusCode: 200, body: `Chunked and stored ${totalChunks} files.` };
        console.log('Processing complete:', result);
        return result;
    } catch (err) {
        console.error('Error processing S3 event:', err);
        return { statusCode: 500, body: `Error processing file: ${err.message}` };
    }
}; 