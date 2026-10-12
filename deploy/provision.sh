#!/usr/bin/env bash
# Launch an Orca box on EC2 from the laptop. Idempotent-ish: reuses the security group and key.
#
#   aws ssm put-parameter --region eu-west-2 --name /orca/tailscale-authkey --type SecureString --value tskey-auth-…
#   deploy/provision.sh [instance-type] [disk-gb]
#
# No inbound security-group rules: the box is reached over Tailscale (and SSM for break-glass).
set -euo pipefail
REGION=${AWS_REGION:-eu-west-2}
TYPE=${1:-m7i.xlarge}
DISK=${2:-150}
NAME=orca-server
here=$(cd "$(dirname "$0")" && pwd)

aws ssm get-parameter --region "$REGION" --name /orca/tailscale-authkey --with-decryption >/dev/null \
  || { echo "put the Tailscale auth key in SSM first (see the header)"; exit 1; }
ami=$(aws ssm get-parameter --region "$REGION" --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
vpc=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
sg=$(aws ec2 describe-security-groups --region "$REGION" --filters Name=group-name,Values=$NAME Name=vpc-id,Values=$vpc --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null)
if [ "$sg" = "None" ] || [ -z "$sg" ]; then
  sg=$(aws ec2 create-security-group --region "$REGION" --group-name $NAME --description "Orca bridge: no ingress, Tailscale + SSM only" --vpc-id "$vpc" --query GroupId --output text)
fi
id=$(aws ec2 run-instances --region "$REGION" --image-id "$ami" --instance-type "$TYPE" \
  --iam-instance-profile Name=AmazonSSMRoleForInstancesQuickSetup \
  --security-group-ids "$sg" \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$DISK,\"VolumeType\":\"gp3\"}}]" \
  --metadata-options HttpTokens=optional \
  --user-data "file://$here/cloud-init.yaml" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=Project,Value=orca},{Key=VantaOwner,Value=${VANTA_OWNER:-finn@flowengineering.com}},{Key=VantaNonProd,Value=true},{Key=VantaContainsUserData,Value=false},{Key=VantaDescription,Value=Orca internal development agent server}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "launched $id ($TYPE, ${DISK}GB, $ami) — cloud-init takes ~5 minutes"
aws ec2 wait instance-running --region "$REGION" --instance-ids "$id"
echo "running. Next: aws ssm start-session --region $REGION --target $id   (then sudo -iu orca; see deploy/cloud-init.yaml header)"
