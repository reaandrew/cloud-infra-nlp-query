exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    // Extract relevant information from the event
    const detail = event.detail || {};
    const instanceId = detail['instance-id'];
    const state = detail.state;
    
    // Log the EC2 event details
    console.log(`EC2 Instance ${instanceId} state changed to ${state}`);
    
    return {
        statusCode: 200,
        body: JSON.stringify({
            message: 'Event logged successfully',
            instanceId: instanceId,
            state: state
        })
    };
}; 