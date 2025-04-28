# lambda_function.py  •  Python 3.12
import os, json, re, gzip, urllib.request, boto3
from datetime import datetime
from urllib.error import HTTPError

S3_BUCKET   = os.environ["DEST_BUCKET"]                 # e.g. "my-doc-bucket"
S3_PREFIX   = os.getenv("DEST_KEY_PREFIX", "config-specs/")
REGION      = os.getenv("REGION",      "eu-west-2")

# ---- helpers ---------------------------------------------------------------

SPEC_URL = {
    # mapping comes from the CloudFormation doc table
    # https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-resource-specification.html
    "eu-west-2": "https://d1742qcu2c1ncx.cloudfront.net/latest/gzip/CloudFormationResourceSpecification.json",
    # add more regions here if you need them
}[REGION]

CONFIG_DOC_URL = (
    "https://docs.aws.amazon.com/config/latest/developerguide/"
    "resource-config-reference.html"
)

def fetch_bytes(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=30) as resp:
        data = resp.read()
    # the CloudFront link is gzip-compressed
    try:
        return gzip.decompress(data)
    except (OSError, gzip.BadGzipFile):
        return data  # already plain-text / JSON


def get_config_resource_types() -> set[str]:
    """Return the set of resource-type strings supported by AWS Config."""
    html = fetch_bytes(CONFIG_DOC_URL).decode("utf-8", errors="ignore")
    # Grab anything that looks like `AWS::Service::Type`
    pattern = r"AWS::[A-Za-z0-9]+::[A-Za-z0-9]+"
    return set(re.findall(pattern, html))


def filter_spec(spec: dict, keep: set[str]) -> dict:
    """Slice the CFN spec down to the resource & property types we care about."""
    res = {
        k: v for k, v in spec["ResourceTypes"].items()
        if k in keep
    }
    prop = {
        k: v for k, v in spec["PropertyTypes"].items()
        if k.split(".")[0] in keep
    }
    return {"ResourceTypes": res, "PropertyTypes": prop}


def upload_to_s3(body: bytes, bucket: str, key: str) -> None:
    boto3.client("s3").put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType="application/json; charset=utf-8"
    )

# ---- Lambda handler --------------------------------------------------------

def lambda_handler(event, context):
    try:
        # 1. download the full spec
        spec_json = json.loads(fetch_bytes(SPEC_URL).decode("utf-8"))
        # 2. scrape supported Config types
        config_types = get_config_resource_types()
        # 3. filter
        trimmed = filter_spec(spec_json, config_types)
        payload  = json.dumps(trimmed, indent=2).encode("utf-8")

        # 4. save to S3
        key = (f"{S3_PREFIX}config_resource_spec_{REGION}_"
               f"{datetime.utcnow():%Y-%m-%d}.json")
        upload_to_s3(payload, S3_BUCKET, key)

        return {
            "status":        "SUCCESS",
            "region":        REGION,
            "keptTypes":     len(trimmed["ResourceTypes"]),
            "s3Key":         key
        }

    except HTTPError as e:
        return {"status": "ERROR", "message": f"HTTP {e.code} {e.reason}"}
    except Exception as exc:
        return {"status": "ERROR", "message": str(exc)} 