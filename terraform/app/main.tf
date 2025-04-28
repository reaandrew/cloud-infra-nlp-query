terraform {
  required_version = ">= 1.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "cloud-infra-nlp-query-tfstate"
    key            = "app/terraform.tfstate"
    region         = "eu-west-2"
    dynamodb_table = "cloud-infra-nlp-query-terraform-state-lock"
  }
}

provider "aws" {
  region = var.aws_region
}

# S3 bucket for storing AWS Config documentation and examples
resource "aws_s3_bucket" "config_docs" {
  bucket = var.config_docs_bucket_name
}

resource "aws_s3_bucket_versioning" "config_docs" {
  bucket = aws_s3_bucket.config_docs.id
  versioning_configuration {
    status = "Enabled"
  }
}

# S3 bucket for config specs (event source)
resource "aws_s3_bucket" "config_specs" {
  bucket = "cinq-config-specs"
}

resource "aws_s3_bucket_versioning" "config_specs" {
  bucket = aws_s3_bucket.config_specs.id
  versioning_configuration {
    status = "Enabled"
  }
}

# S3 bucket for storing config spec chunks (destination)
resource "aws_s3_bucket" "config_spec_chunks" {
  bucket = "cinq-config-spec-chunks"
}

resource "aws_s3_bucket_versioning" "config_spec_chunks" {
  bucket = aws_s3_bucket.config_spec_chunks.id
  versioning_configuration {
    status = "Enabled"
  }
}

# S3 event notification for chunks bucket
resource "aws_s3_bucket_notification" "config_chunks_events" {
  bucket = aws_s3_bucket.config_spec_chunks.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.fetch_vectors.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "chunks/"
  }

  depends_on = [
    aws_lambda_permission.allow_s3_invoke_fetch_vectors,
    aws_s3_bucket.config_spec_chunks
  ]
}

# IAM role for the Lambda functions
resource "aws_iam_role" "lambda_role" {
  name = "config-query-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

# IAM policy for the Lambda functions
resource "aws_iam_role_policy" "lambda_policy" {
  name = "config-query-lambda-policy"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "config:SelectAggregateResourceConfig",
          "config:SelectResourceConfig"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${var.aws_region}:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.config_docs.arn,
          "${aws_s3_bucket.config_docs.arn}/*",
          aws_s3_bucket.config_specs.arn,
          "${aws_s3_bucket.config_specs.arn}/*"
        ]
      }
    ]
  })
}

# Lambda function for executing Config queries
resource "aws_lambda_function" "config_query" {
  filename         = "lambda/config_query.zip"
  function_name    = "cloud-infra-nlp-query-config-query"
  role            = aws_iam_role.lambda_role.arn
  handler         = "index.handler"
  runtime         = "nodejs18.x"
  timeout         = 30
  memory_size     = 256

  environment {
    variables = {
      CONFIG_DOCS_BUCKET = aws_s3_bucket.config_docs.id
    }
  }
}

# Lambda function for refreshing documentation
resource "aws_lambda_function" "refresh_docs_data" {
  filename         = "lambda/refresh_docs_data.zip"
  function_name    = "cloud-infra-nlp-query-refresh-docs"
  role            = aws_iam_role.lambda_role.arn
  handler         = "lambda_function.lambda_handler"
  runtime         = "python3.12"
  timeout         = 60
  memory_size     = 256
  source_code_hash = filebase64sha256("lambda/refresh_docs_data.zip")

  environment {
    variables = {
      DEST_BUCKET = aws_s3_bucket.config_specs.id
      DEST_KEY_PREFIX = "config-specs/"
      REGION = var.aws_region
    }
  }
}

# API Gateway REST API
resource "aws_apigatewayv2_api" "config_query" {
  name          = "config-query-api"
  protocol_type = "HTTP"
}

# API Gateway integration with Lambda
resource "aws_apigatewayv2_integration" "config_query" {
  api_id           = aws_apigatewayv2_api.config_query.id
  integration_type = "AWS_PROXY"

  connection_type      = "INTERNET"
  description         = "Lambda integration"
  integration_method  = "POST"
  integration_uri     = aws_lambda_function.config_query.invoke_arn
}

# API Gateway route
resource "aws_apigatewayv2_route" "config_query" {
  api_id    = aws_apigatewayv2_api.config_query.id
  route_key = "POST /query"
  target    = "integrations/${aws_apigatewayv2_integration.config_query.id}"
}

# API Gateway stage
resource "aws_apigatewayv2_stage" "config_query" {
  api_id = aws_apigatewayv2_api.config_query.id
  name   = "prod"
  auto_deploy = true
}

# Lambda permission for API Gateway
resource "aws_lambda_permission" "config_query" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.config_query.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.config_query.execution_arn}/*/*"
}

# IAM role for chunking Lambda
resource "aws_iam_role" "chunk_lambda_role" {
  name = "chunk-config-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "chunk_lambda_policy" {
  name = "chunk-config-lambda-policy"
  role = aws_iam_role.chunk_lambda_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject"
        ]
        Resource = [
          "${aws_s3_bucket.config_specs.arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject"
        ]
        Resource = [
          aws_s3_bucket.config_spec_chunks.arn,
          "${aws_s3_bucket.config_spec_chunks.arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${var.aws_region}:*:*"
      }
    ]
  })
}

resource "aws_lambda_function" "chunk_config" {
  filename         = "lambda/chunk_config_spec.zip"
  function_name    = "cloud-infra-nlp-query-chunk-config"
  role             = aws_iam_role.chunk_lambda_role.arn
  handler          = "index.handler"
  runtime          = "nodejs18.x"
  timeout          = 60
  memory_size      = 256
  source_code_hash = filebase64sha256("lambda/chunk_config_spec.zip")

  environment {
    variables = {
      CHUNKS_BUCKET = aws_s3_bucket.config_spec_chunks.id
    }
  }
}

# S3 event notification for source bucket
resource "aws_s3_bucket_notification" "config_spec_events" {
  bucket = aws_s3_bucket.config_specs.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.chunk_config.arn
    events              = ["s3:ObjectCreated:*"]
    filter_suffix       = ".json"
  }

  depends_on = [
    aws_lambda_permission.allow_s3_invoke_chunk_config,
    aws_s3_bucket.config_specs
  ]
}

# Lambda permission for S3 to invoke chunk_config
resource "aws_lambda_permission" "allow_s3_invoke_chunk_config" {
  statement_id  = "AllowS3InvokeChunkConfig"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.chunk_config.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.config_specs.arn
}

# IAM role for the fetch_vectors Lambda
resource "aws_iam_role" "fetch_vectors_role" {
  name = "fetch-vectors-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

# IAM policy for fetch_vectors Lambda
resource "aws_iam_role_policy" "fetch_vectors_policy" {
  name = "fetch-vectors-lambda-policy"
  role = aws_iam_role.fetch_vectors_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${var.aws_region}:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.config_spec_chunks.arn,
          "${aws_s3_bucket.config_spec_chunks.arn}/*"
        ]
      }
    ]
  })
}

# Lambda function for fetching vectors/events from chunks
resource "aws_lambda_function" "fetch_vectors" {
  filename         = "lambda/fetch_vectors.zip"
  function_name    = "cloud-infra-nlp-query-fetch-vectors"
  role             = aws_iam_role.fetch_vectors_role.arn
  handler          = "index.handler"
  runtime          = "nodejs18.x"
  timeout          = 60
  memory_size      = 256
  source_code_hash = filebase64sha256("lambda/fetch_vectors.zip")

  environment {
    variables = {
      REGION = var.aws_region
    }
  }
}

# Lambda permission for S3 to invoke fetch_vectors
resource "aws_lambda_permission" "allow_s3_invoke_fetch_vectors" {
  statement_id  = "AllowS3InvokeFetchVectors"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fetch_vectors.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.config_spec_chunks.arn
} 