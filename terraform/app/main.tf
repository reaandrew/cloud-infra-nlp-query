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
          "${aws_s3_bucket.config_docs.arn}/*"
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

  environment {
    variables = {
      DEST_BUCKET = aws_s3_bucket.config_docs.id
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