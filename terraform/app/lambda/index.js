exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    // Extract basic event information
    const eventSource = event.source || 'unknown';
    const detailType = event['detail-type'] || 'unknown';
    const eventTime = event.time || new Date().toISOString();
    const detail = event.detail || {};
    
    // Log the event details
    console.log(`Received ${detailType} event from ${eventSource} at ${eventTime}`);
    console.log(`Event detail: ${JSON.stringify(detail, null, 2)}`);
    
    // Handle different event types
    if (eventSource.includes('demo.aws.ec2')) {
        // EC2 specific handling
        const instanceId = detail['instance-id'];
        const state = detail.state;
        if (instanceId && state) {
            console.log(`EC2 Instance ${instanceId} state changed to ${state}`);
        }
    } else {
        console.log(`Processing general event from ${eventSource}`);
    }
    
    return {
        statusCode: 200,
        body: JSON.stringify({
            message: 'Event processed successfully',
            source: eventSource,
            detailType: detailType,
            time: eventTime
        })
    };
}; 