#!/usr/bin/env python3

import argparse
import json
import os
import random
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

try:
    from faker import Faker
except ImportError:
    print("Faker library not found. Installing...")
    import subprocess
    subprocess.check_call(["pip", "install", "faker"])
    from faker import Faker

try:
    import boto3
except ImportError:
    print("Boto3 library not found. Installing...")
    import subprocess
    subprocess.check_call(["pip", "install", "boto3"])
    import boto3

# Initialize Faker
fake = Faker()

# Default region
DEFAULT_REGION = "eu-west-2"

# AWS account ID format
def generate_aws_account_id():
    return ''.join(random.choice('0123456789') for _ in range(12))

# AWS ARN generator for various services
def generate_arn(service, resource_type, region=None, account_id=None, resource_id=None):
    if not account_id:
        account_id = generate_aws_account_id()
    if not region:
        region = DEFAULT_REGION
    if not resource_id:
        resource_id = f"{fake.word()}-{uuid.uuid4().hex[:8]}"
    
    if service == 's3':
        return f"arn:aws:s3:::{resource_id}"
    else:
        return f"arn:aws:{service}:{region}:{account_id}:{resource_type}/{resource_id}"

# Generate random values based on schema property types
def generate_value_for_property(property_name, property_schema):
    property_type = property_schema.get('type', 'string')
    
    # Handle specific property names regardless of type
    if property_name in ['account', 'account-id', 'accountId']:
        return generate_aws_account_id()
    elif property_name == 'region':
        return DEFAULT_REGION
    elif property_name == 'id' or property_name.endswith('Id'):
        return str(uuid.uuid4())
    elif property_name == 'time' or property_name.endswith('Time') or property_name.endswith('At'):
        return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    elif 'arn' in property_name.lower():
        service = property_name.split('Arn')[0].lower() if 'Arn' in property_name else 'service'
        return generate_arn(service, 'resource')
    elif property_name == 'source':
        return f"demo.aws.{fake.word()}"
    
    # Handle based on type
    if property_type == 'string':
        if property_name.lower().endswith('name'):
            return fake.word() + '-' + fake.word()
        elif 'ip' in property_name.lower():
            return fake.ipv4()
        elif 'etag' in property_name.lower():
            return fake.md5()
        elif 'key' in property_name.lower():
            return f"{fake.word()}/{fake.file_name()}"
        else:
            return fake.word()
    elif property_type == 'number' or property_type == 'integer':
        return random.randint(1, 10000)
    elif property_type == 'boolean':
        return random.choice([True, False])
    elif property_type == 'array':
        items_schema = property_schema.get('items', {})
        return [generate_value_for_property(property_name + '_item', items_schema) for _ in range(random.randint(1, 3))]
    elif property_type == 'object':
        if 'properties' in property_schema:
            return generate_object_from_schema(property_schema)
        else:
            return {fake.word(): fake.word() for _ in range(random.randint(1, 3))}
    
    return fake.word()

# Generate object from schema
def generate_object_from_schema(schema):
    obj = {}
    
    if 'properties' not in schema:
        return obj
    
    properties = schema.get('properties', {})
    required = schema.get('required', [])
    
    for prop_name, prop_schema in properties.items():
        # Always include required properties, randomly include others
        if prop_name in required or random.random() > 0.2:
            # Handle references
            if '$ref' in prop_schema:
                ref_path = prop_schema['$ref']
                # Extract component name from path like "#/components/schemas/Something"
                component_name = ref_path.split('/')[-1]
                if component_name in schema_components:
                    obj[prop_name] = generate_object_from_schema(schema_components[component_name])
                else:
                    obj[prop_name] = generate_value_for_property(prop_name, {})
            else:
                obj[prop_name] = generate_value_for_property(prop_name, prop_schema)
    
    return obj

# Parse AWS EventBridge schema and generate sample event
def generate_event_from_schema(schema_path, region=None):
    global schema_components
    
    if not region:
        region = DEFAULT_REGION
    
    try:
        with open(schema_path, 'r') as f:
            schema = json.load(f)
    except (json.JSONDecodeError, FileNotFoundError) as e:
        print(f"Error loading schema: {e}")
        return None
    
    # Extract components for reference resolution
    schema_components = schema.get('components', {}).get('schemas', {})
    
    # Find the AWSEvent schema which is the root
    aws_event_schema = schema_components.get('AWSEvent', {})
    if not aws_event_schema:
        print(f"AWSEvent schema not found in {schema_path}")
        return None
    
    # Get common fields
    detail_type = aws_event_schema.get('x-amazon-events-detail-type', 'Unknown Event')
    source = aws_event_schema.get('x-amazon-events-source', 'aws.unknown')
    
    # Modify the source to use demo.aws.* pattern
    source_service = source.replace('aws.', '')
    source = f"demo.aws.{source_service}"
    
    account_id = generate_aws_account_id()
    
    # Generate proper ARNs for resources
    resources = []
    for _ in range(1):  # Just generate one resource to minimize potential issues
        if source_service == 's3':
            bucket_name = f"example-bucket-{uuid.uuid4().hex[:8]}"
            resources.append(f"arn:aws:s3:::{bucket_name}")
        else:
            resource_id = f"test-resource-{uuid.uuid4().hex[:8]}"
            resources.append(f"arn:aws:{source_service}:{region}:{account_id}:resource/{resource_id}")
    
    # Generate the event with a simpler structure
    event = {
        'version': '0',
        'id': str(uuid.uuid4()),
        'detail-type': detail_type,
        'source': source,
        'account': account_id,
        'time': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'region': region,
        'resources': resources,
    }
    
    # Generate detail based on detailed schema
    detail_schema_ref = aws_event_schema.get('properties', {}).get('detail', {}).get('$ref')
    if detail_schema_ref:
        detail_schema_name = detail_schema_ref.split('/')[-1]
        if detail_schema_name in schema_components:
            event['detail'] = generate_object_from_schema(schema_components[detail_schema_name])
    else:
        # Add a simple detail if no schema is available
        event['detail'] = {
            'message': f"Test event generated for {source}",
            'timestamp': datetime.now(timezone.utc).isoformat()
        }
    
    return event

def find_event_schema(event_type):
    schema_dir = Path('data/aws_event_schemas')
    
    # Check if the input is in service:event format (e.g., "s3:ObjectCreated")
    if ':' in event_type:
        service_name, specific_event = event_type.lower().split(':', 1)
        for schema_file in schema_dir.glob('*.json'):
            file_name = schema_file.name
            match = re.match(r'aws\.([^@]+)@(.+)\.json', file_name)
            if match:
                file_service, file_event = match.groups()
                # Check if both service and event name match
                if file_service.lower() == service_name and file_event.lower() == specific_event.lower():
                    return schema_file
    
    # If the event type is a complete schema filename, use it directly
    if event_type.endswith('.json'):
        schema_path = schema_dir / event_type
        if schema_path.exists():
            return schema_path
    
    # Check if the input is just a service name (e.g., 's3', 'ec2')
    service_name = event_type.lower()
    service_schemas = []
    
    for schema_file in schema_dir.glob('*.json'):
        # Extract service name from filename format "aws.<service>@<EventName>.json"
        file_name = schema_file.name
        service_match = re.match(r'aws\.([^@]+)@', file_name)
        
        if service_match:
            file_service = service_match.group(1).lower()
            # Check if this file belongs to the specified service
            if file_service == service_name:
                service_schemas.append(schema_file)
    
    # If we found schemas for this service, randomly select one
    if service_schemas:
        selected_schema = random.choice(service_schemas)
        service_name, event_name = re.match(r'aws\.([^@]+)@(.+)\.json', selected_schema.name).groups()
        print(f"Randomly selected event type: {service_name}:{event_name}")
        return selected_schema
    
    # Look for schemas containing the event type in the filename
    matches = []
    for schema_file in schema_dir.glob('*.json'):
        file_name = schema_file.name
        # Check if the event type is in the filename
        if event_type.lower() in file_name.lower():
            matches.append(schema_file)
    
    if matches:
        # Return the first match if there are multiple
        return matches[0]
    
    return None

def list_available_events():
    schema_dir = Path('data/aws_event_schemas')
    events = []
    
    for schema_file in schema_dir.glob('*.json'):
        # Extract service and event name from filename format "aws.<service>@<EventName>.json"
        file_name = schema_file.name
        match = re.match(r'aws\.(.+)@(.+)\.json', file_name)
        if match:
            service, event_name = match.groups()
            events.append((service, event_name, str(schema_file)))
    
    return events

def publish_event_to_eventbridge(event, event_bus=None, region=None):
    """
    Publish the generated event to AWS EventBridge
    
    Args:
        event (dict): The event to publish
        event_bus (str, optional): The name of the EventBridge event bus. Defaults to the default event bus.
        region (str, optional): AWS region to use. Defaults to the region in the event or DEFAULT_REGION.
    
    Returns:
        dict: The response from EventBridge PutEvents API
    """
    if not region:
        # Try to use the region in the event, otherwise default to DEFAULT_REGION
        region = event.get('region', DEFAULT_REGION)
    
    # Create EventBridge client
    try:
        events_client = boto3.client('events', region_name=region)
    except Exception as e:
        print(f"Error creating EventBridge client: {e}")
        return None
    
    # Debug: Print the event we're about to send
    print(f"Preparing to send event to EventBridge:")
    print(f"- Source: {event['source']}")
    print(f"- DetailType: {event['detail-type']}")
    print(f"- Region: {region}")
    
    # Prepare the entry - only include required fields
    entry = {
        'Source': event['source'],
        'DetailType': event['detail-type'],
        'Detail': json.dumps(event['detail']) if 'detail' in event else '{}',
    }
    
    # Add EventBusName only if specified
    if event_bus:
        entry['EventBusName'] = event_bus
    
    # Resources are optional and can sometimes cause issues
    # Only include if they're ARNs (they must be ARNs for EventBridge)
    if 'resources' in event and event['resources'] and all(resource.startswith('arn:') for resource in event['resources']):
        entry['Resources'] = event['resources']
    
    # Debug: Print the entry
    print(f"EventBridge entry: {json.dumps(entry, indent=2)}")
    
    # Send event to EventBridge
    try:
        print(f"Sending event to EventBridge in {region}...")
        response = events_client.put_events(Entries=[entry])
        
        # Debug: Print full response
        print(f"EventBridge response: {json.dumps(response, default=str, indent=2)}")
        
        if response['FailedEntryCount'] > 0:
            print(f"Failed to publish event: {response}")
            return None
            
        print(f"Successfully published event to EventBridge in {region}")
        
        # Return entry ID to confirm success
        if 'Entries' in response and response['Entries'] and 'EventId' in response['Entries'][0]:
            print(f"Event ID: {response['Entries'][0]['EventId']}")
            
        return response
    except Exception as e:
        print(f"Error publishing event: {e}")
        print(f"Make sure you have proper AWS credentials configured when running with aws-vault")
        return None

def main():
    parser = argparse.ArgumentParser(description='Generate AWS EventBridge sample events')
    parser.add_argument('event_type', nargs='?', 
                        help='Event type or service name (e.g., "s3", "s3:ObjectCreated")')
    parser.add_argument('--list', action='store_true', help='List available event types')
    parser.add_argument('--output', '-o', help='Output file path (defaults to stdout)')
    parser.add_argument('--publish', nargs='?', const='default', metavar='EVENT_BUS',
                        help='Publish the event to AWS EventBridge. Optionally specify an event bus name (defaults to the default event bus)')
    parser.add_argument('--region', default=DEFAULT_REGION, 
                        help=f'AWS region to use for the event and publishing (defaults to {DEFAULT_REGION})')
    parser.add_argument('--debug', action='store_true', help='Print additional debugging information')
    parser.add_argument('--test-pattern', action='store_true', 
                        help='Test the event pattern match before publishing')
    
    args = parser.parse_args()
    
    if args.debug:
        print("Script running with AWS SDK version:", boto3.__version__)
        print(f"Default region: {DEFAULT_REGION}")
        
        # Check if credentials are available
        try:
            session = boto3.Session(region_name=args.region)
            if session.get_credentials():
                print("AWS credentials found")
            else:
                print("AWS credentials not found. If using aws-vault, run with: aws-vault exec YOUR_PROFILE -- ./scripts/generate_aws_events.py ...")
        except Exception as e:
            print(f"Error checking credentials: {e}")
    
    if args.list:
        events = list_available_events()
        print("Available event types:")
        # Group by service for better readability
        services = {}
        for service, event_name, schema_path in events:
            if service not in services:
                services[service] = []
            services[service].append(event_name)
        
        for service in sorted(services.keys()):
            print(f"\n{service}:")
            for event_name in sorted(services[service]):
                print(f"  - {service}:{event_name}")
        return
    
    if not args.event_type:
        parser.print_help()
        return
    
    schema_path = find_event_schema(args.event_type)
    if not schema_path:
        print(f"Error: Could not find schema for event type or service '{args.event_type}'")
        print("Use --list to see available event types")
        return
    
    event = generate_event_from_schema(schema_path, region=args.region)
    if event:
        # Test EventBridge pattern match if requested
        if args.test_pattern and args.publish:
            try:
                import subprocess
                pattern = '{"source":[{"prefix":"demo.aws"}]}'
                event_json = json.dumps(event)
                print(f"\nTesting if event matches EventBridge pattern: {pattern}")
                
                cmd = ["aws", "events", "test-event-pattern", 
                       "--event-pattern", pattern, 
                       "--event", event_json]
                
                if args.debug:
                    print(f"Running command: {' '.join(cmd)}")
                
                result = subprocess.run(cmd, capture_output=True, text=True)
                print(f"Pattern match result: {result.stdout.strip()}")
                
                if result.returncode != 0:
                    print(f"Error testing pattern: {result.stderr}")
                    print("This event might not match your EventBridge rule pattern.")
            except Exception as e:
                print(f"Error testing pattern match: {e}")
        
        # Save to file if output path is provided
        if args.output:
            with open(args.output, 'w') as f:
                json.dump(event, f, indent=2)
            print(f"Event saved to {args.output}")
        
        # Publish to EventBridge if requested
        if args.publish:
            print("\nPublishing event to EventBridge:")
            if args.debug:
                print("Use this event with aws-vault if needed:")
                print(f"aws-vault exec YOUR_PROFILE -- aws events put-events --entries Source={event['source']},DetailType='{event['detail-type']}',Detail='{json.dumps(event['detail'])}' --region {args.region}")
            
            if publish_event_to_eventbridge(event, args.publish, args.region):
                print("\nEvent successfully published!")
                print(f"Check your Lambda logs in CloudWatch: /aws/lambda/{args.region}")
            else:
                print("\nFailed to publish event to EventBridge")
                print("If using aws-vault, try: aws-vault exec YOUR_PROFILE -- ./scripts/generate_aws_events.py ...")
        
        # Print to stdout if not saving to file
        if not args.output:
            print("\nGenerated event:")
            print(json.dumps(event, indent=2))

if __name__ == '__main__':
    main() 