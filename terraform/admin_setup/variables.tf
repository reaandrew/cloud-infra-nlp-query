variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "eu-west-2"
}

variable "state_bucket_name" {
  description = "Name of the S3 bucket for Terraform state"
  type        = string
}

variable "dynamodb_table_name" {
  description = "Name of the DynamoDB table for state locking"
  type        = string
  default     = "terraform-state-lock"
}

variable "ci_role_name" {
  description = "Name of the CI IAM role"
  type        = string
  default     = "cloud-infra-nlp-query-ci-role"
}

variable "app_name" {
  description = "Name of the application"
  type        = string
  default     = "cloud-infra-nlp-query"
} 