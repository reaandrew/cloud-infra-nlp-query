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
      }
    ]
  })
}

# Create Lambda function
resource "aws_lambda_function" "ec2_event_logger" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.app_name}-ec2-event-logger"
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

# Create EventBridge rule for EC2 events
resource "aws_cloudwatch_event_rule" "ec2_events" {
  name        = "${var.app_name}-ec2-events"
  description = "Capture EC2 events"

  event_pattern = jsonencode({
    source      = ["demo.aws.ec2"],
    detail-type = ["EC2 Instance State-change Notification"]
  })
}

# Create EventBridge target
resource "aws_cloudwatch_event_target" "lambda_target" {
  rule      = aws_cloudwatch_event_rule.ec2_events.name
  target_id = "SendToLambda"
  arn       = aws_lambda_function.ec2_event_logger.arn
}

# Create Lambda permission for EventBridge
resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ec2_event_logger.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ec2_events.arn
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