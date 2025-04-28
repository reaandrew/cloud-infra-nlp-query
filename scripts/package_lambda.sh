#!/bin/bash

# Script to package Lambda functions for deployment

# Create lambda directory in terraform/app if it doesn't exist
mkdir -p terraform/app/lambda

# Package config_query Lambda (Node.js)
echo "Packaging config_query Lambda..."
cd lambda/config_query
zip -r ../../terraform/app/lambda/config_query.zip .
cd ../..

# Package refresh_docs_data Lambda (Python)
echo "Packaging refresh_docs_data Lambda..."
cd lambda/refresh_docs_data
zip -r ../../terraform/app/lambda/refresh_docs_data.zip .
cd ../..

# Package chunk_config_spec Lambda (Node.js)
echo "Packaging chunk_config_spec Lambda..."
cd lambda/chunk_config_spec
zip -r ../../terraform/app/lambda/chunk_config_spec.zip .
cd ../..

# Package fetch_vectors Lambda (Node.js)
echo "Packaging fetch_vectors Lambda..."
cd lambda/fetch_vectors
zip -r ../../terraform/app/lambda/fetch_vectors.zip .
cd ../..

echo "Lambda packaging complete!" 