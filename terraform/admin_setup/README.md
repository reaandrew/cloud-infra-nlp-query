# Admin Setup for Terraform Backend and CI Role

This directory contains Terraform configurations for setting up:
1. S3 bucket for Terraform state storage
2. DynamoDB table for state locking
3. IAM role and policy for CI/CD pipeline

## Prerequisites

- AWS CLI configured with appropriate credentials
- Terraform >= 1.0.0
- Appropriate AWS permissions to create S3 buckets, DynamoDB tables, and IAM roles

## Usage

1. Initialize Terraform:
```bash
terraform init
```

2. Create a `terraform.tfvars` file with your desired values:
```hcl
aws_region         = "us-west-2"
state_bucket_name  = "your-terraform-state-bucket"
dynamodb_table_name = "terraform-state-lock"
ci_role_name       = "cloud-infra-nlp-query-ci-role"
```

3. Apply the configuration:
```bash
terraform apply
```

4. After successful apply, configure the backend for other Terraform configurations:
```bash
terraform init \
  -backend-config="bucket=your-terraform-state-bucket" \
  -backend-config="key=admin/terraform.tfstate" \
  -backend-config="region=us-west-2" \
  -backend-config="dynamodb_table=terraform-state-lock"
```

## Important Notes

- The S3 bucket has `prevent_destroy` lifecycle rule to prevent accidental deletion
- The CI role is configured to be assumed by AWS CodeBuild
- The CI role has permissions to access the Terraform state bucket and DynamoDB table
- Server-side encryption is enabled on the S3 bucket
- Versioning is enabled on the S3 bucket

## Outputs

After applying the configuration, you'll get:
- S3 bucket name and ARN
- DynamoDB table name
- CI role ARN and name

These outputs can be used to configure your CI/CD pipeline. 