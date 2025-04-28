.PHONY: init package deploy clean

# Default target
all: init package deploy

# Initialize Terraform
init:
	@echo "Initializing Terraform..."
	cd terraform/app && terraform init

# Package Lambda functions
package:
	@echo "Packaging Lambda functions..."
	./scripts/package_lambda.sh

# Deploy infrastructure
deploy: package
	@echo "Deploying infrastructure..."
	cd terraform/app && terraform apply -auto-approve

# Clean up generated files
clean:
	@echo "Cleaning up..."
	rm -f terraform/app/lambda/*.zip
	rm -f terraform/app/.terraform.lock.hcl
	rm -rf terraform/app/.terraform

# Help target
help:
	@echo "Available targets:"
	@echo "  init     - Initialize Terraform"
	@echo "  package  - Package Lambda functions"
	@echo "  deploy   - Deploy infrastructure (includes packaging)"
	@echo "  clean    - Clean up generated files"
	@echo "  all      - Run init, package, and deploy"
	@echo "  help     - Show this help message" 