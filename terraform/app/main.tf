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

# Create IAM role for Lambda
resource "aws_iam_role" "lambda_role" {
  name = "${var.app_name}-lambda-role"

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

# Create IAM policy for Lambda
resource "aws_iam_role_policy" "lambda_policy" {
  name = "${var.app_name}-lambda-policy"
  role = aws_iam_role.lambda_role.id

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
          "events:PutEvents"
        ]
        Resource = "arn:aws:events:${var.aws_region}:*:event-bus/default"
      }
    ]
  })
}

# Create Lambda function
resource "aws_lambda_function" "lambda_event_processor" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.app_name}-event-processor"
  role            = aws_iam_role.lambda_role.arn
  handler         = "index.handler"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  runtime         = "nodejs18.x"

  environment {
    variables = {
      LOG_LEVEL = "INFO"
    }
  }
}

# Create EventBridge rule for AWS events
resource "aws_cloudwatch_event_rule" "demo_aws_events" {
  name        = "${var.app_name}-events" # Keep a consistent name to avoid recreation
  description = "Capture all demo AWS events"

  event_pattern = jsonencode({
    source = [
      {"prefix": "demo.aws"}
    ]
  })

  # Prevent destroy until target is removed
  lifecycle {
    create_before_destroy = true
  }
}

# Create EventBridge rule for vectorization-ready events
resource "aws_cloudwatch_event_rule" "vectorization_events" {
  name        = "${var.app_name}-vectorization-events"
  description = "Capture all vectorization-ready events"

  event_pattern = jsonencode({
    source = ["app.event-processor"],
    "detail-type" = ["Vectorization Ready Event"]
  })

  lifecycle {
    create_before_destroy = true
  }
}

# Create EventBridge target
resource "aws_cloudwatch_event_target" "lambda_target" {
  rule      = aws_cloudwatch_event_rule.demo_aws_events.name
  target_id = "SendToLambda"
  arn       = aws_lambda_function.lambda_event_processor.arn
}

# Create Lambda permission for EventBridge
resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowEventBridge-${aws_cloudwatch_event_rule.demo_aws_events.name}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lambda_event_processor.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.demo_aws_events.arn
}

# Create zip file for Lambda function
data "archive_file" "lambda_zip" {
  type        = "zip"
  output_path = "${path.module}/lambda_function.zip"

  source {
    content  = file("${path.module}/lambda/index.js")
    filename = "index.js"
  }
} 