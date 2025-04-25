const { EventBridgeClient, PutEventsCommand } = require("@aws-sdk/client-eventbridge");

// Create EventBridge client
const eventBridge = new EventBridgeClient();

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

    // Extract meaningful fields from detail
    // We're being general here to handle any event type
    const extractedFields = {};
    const keyDetails = [];

    // Process detail object
    Object.entries(detail).forEach(([key, value]) => {
        // Skip large nested objects or arrays for vectorization efficiency
        if (typeof value !== 'object' || value === null) {
            extractedFields[key] = value;

            // Add human-readable details for important fields
            if (key.includes('id') ||
                key.includes('name') ||
                key.includes('status') ||
                key.includes('state') ||
                key.includes('type')) {
                keyDetails.push(`${key}: ${value}`);
            }
        } else if (Array.isArray(value)) {
            // For arrays, we'll include length and a sample
            extractedFields[key] = `Array with ${value.length} items`;
            if (value.length > 0) {
                // Get first item sample, but keep it short
                const sample = JSON.stringify(value[0]).substring(0, 50);
                keyDetails.push(`${key}: ${value.length} items, e.g., ${sample}${sample.length >= 50 ? '...' : ''}`);
            }
        } else {
            // For objects, process first level key-value pairs
            extractedFields[key] = {};
            Object.entries(value).forEach(([subKey, subValue]) => {
                if (typeof subValue !== 'object' || subValue === null) {
                    extractedFields[key][subKey] = subValue;

                    if (subKey.includes('id') ||
                        subKey.includes('name') ||
                        subKey.includes('status') ||
                        subKey.includes('state') ||
                        subKey.includes('type')) {
                        keyDetails.push(`${key}.${subKey}: ${subValue}`);
                    }
                }
            });
        }
    });

    // Add key details to summary
    if (keyDetails.length > 0) {
        summary.push(`Key details: ${keyDetails.join(', ')}`);
    }

    // Create the final vectorization-friendly object
    return {
        // Metadata section
        metadata: {
            timestamp,
            source,
            eventType,
            region,
            account,
            eventId
        },
        // Extracted data section - simplified for LLM processing
        extractedData: extractedFields,
        // Human-readable summary for better context
        summary: summary.join('. '),
        // Original event reference
        originalEvent: {
            source: event.source,
            detailType: event['detail-type'],
            time: event.time,
            id: event.id
        }
    };
}

/**
 * Publishes the transformed event to EventBridge default bus
 */
async function publishToEventBridge(transformedEvent) {
    const params = {
        Entries: [
            {
                Source: 'app.event-processor',
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