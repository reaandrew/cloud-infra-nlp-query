const { EventBridgeClient, PutEventsCommand } = require("@aws-sdk/client-eventbridge");

// Create EventBridge client
const eventBridge = new EventBridgeClient();

// App name prefix for events
const APP_NAME_PREFIX = "cloud-infra-nlp";

/**
 * Extracts key metadata from an AWS event in a consistent format
 * suitable for vectorization by an LLM embeddings service
 */
function transformEventForVectorization(event) {
    // Basic event metadata - always present
    const timestamp = event.time || new Date().toISOString();
    const source = event.source || 'unknown';
    const eventType = event['detail-type'] || 'unknown';
    const region = event.region || process.env.AWS_REGION;
    const account = event.account || 'unknown';
    const eventId = event.id || `generated-${Date.now()}`;

    // Extract meaningful information from event details
    const detail = event.detail || {};

    // Build a structured summary of the event
    const summary = [];

    // Add event type description
    summary.push(`${eventType} event occurred in ${region}`);

    // Add source description
    const sourceParts = source.split('.');
    const serviceName = sourceParts.length > 1 ? sourceParts[sourceParts.length - 1] : source;
    summary.push(`Service: ${serviceName}`);

    // Extract meaningful fields from detail - focus on important fields for vectorization
    const extractedFields = {};
    const keyDetails = [];

    // Process detail object - more selective about what we include
    Object.entries(detail).forEach(([key, value]) => {
        // Skip large nested objects or arrays for vectorization efficiency
        if (typeof value !== 'object' || value === null) {
            // Only include fields that are likely to be important for vectorization
            if (key.includes('id') ||
                key.includes('name') ||
                key.includes('status') ||
                key.includes('state') ||
                key.includes('type') ||
                key.includes('key') ||
                key.includes('bucket') ||
                key.includes('arn')) {
                extractedFields[key] = value;
                keyDetails.push(`${key}: ${value}`);
            }
        } else if (Array.isArray(value)) {
            // For arrays, only include if they're small and contain important information
            if (value.length <= 3) {
                extractedFields[key] = value.map(item => {
                    if (typeof item === 'object') {
                        // For objects in arrays, only include important fields
                        const simplified = {};
                        Object.entries(item).forEach(([k, v]) => {
                            if (k.includes('id') || k.includes('name') || k.includes('type')) {
                                simplified[k] = v;
                            }
                        });
                        return simplified;
                    }
                    return item;
                });
            } else {
                // For larger arrays, just include the count
                extractedFields[key] = `Array with ${value.length} items`;
            }
        } else {
            // For objects, only process important fields
            const importantFields = {};
            Object.entries(value).forEach(([subKey, subValue]) => {
                if (subKey.includes('id') ||
                    subKey.includes('name') ||
                    subKey.includes('status') ||
                    subKey.includes('state') ||
                    subKey.includes('type') ||
                    subKey.includes('key') ||
                    subKey.includes('bucket') ||
                    subKey.includes('arn')) {
                    importantFields[subKey] = subValue;
                    keyDetails.push(`${key}.${subKey}: ${subValue}`);
                }
            });

            // Only include the object if it has important fields
            if (Object.keys(importantFields).length > 0) {
                extractedFields[key] = importantFields;
            }
        }
    });

    // Add key details to summary
    if (keyDetails.length > 0) {
        summary.push(`Key details: ${keyDetails.join(', ')}`);
    }

    // Create the final vectorization-friendly object
    return {
        // Metadata section - streamlined
        metadata: {
            timestamp,
            source,
            eventType,
            region,
            account,
            eventId,
            appName: APP_NAME_PREFIX
        },
        // Extracted data section - simplified for LLM processing
        extractedData: extractedFields,
        // Human-readable summary for better context
        summary: summary.join('. ')
    };
}

/**
 * Publishes the transformed event to EventBridge default bus
 */
async function publishToEventBridge(transformedEvent) {
    const params = {
        Entries: [
            {
                Source: `${APP_NAME_PREFIX}.event-processor`,
                DetailType: 'Vectorization Ready Event',
                Detail: JSON.stringify(transformedEvent),
                EventBusName: 'default'
            }
        ]
    };

    try {
        // Log the event we're about to publish
        console.log('Publishing event to EventBridge:', JSON.stringify(params, null, 2));

        const command = new PutEventsCommand(params);
        const result = await eventBridge.send(command);
        console.log('Successfully published to EventBridge. Response:', JSON.stringify(result, null, 2));
        return result;
    } catch (error) {
        console.error('Error publishing to EventBridge:', error);
        throw error;
    }
}

exports.handler = async (event) => {
    try {
        console.log('Received event:', JSON.stringify(event, null, 2));

        // 1. Transform the event into vectorization-friendly format
        const transformedEvent = transformEventForVectorization(event);

        console.log('Transformed event for vectorization:', JSON.stringify(transformedEvent, null, 2));

        // 2. Publish transformed event to EventBridge
        const publishResult = await publishToEventBridge(transformedEvent);

        // Log the complete flow for debugging
        console.log('Event processing complete. Event ID:', transformedEvent.metadata.eventId);
        console.log('Publish result:', JSON.stringify(publishResult, null, 2));

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Event processed and published successfully',
                eventId: transformedEvent.metadata.eventId,
                publishResult: publishResult
            })
        };
    } catch (error) {
        console.error('Error processing event:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: 'Error processing event',
                error: error.message
            })
        };
    }
}; 