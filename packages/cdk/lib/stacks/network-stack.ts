import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";
import { BRIDGE_PORT, UI_PROXY_PORT } from "@serverless-openclaw/shared";

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly fargateSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC — Public subnets only, no NAT Gateway ($0/month)
    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // VPC Gateway Endpoints — free, avoids NAT for AWS service traffic
    this.vpc.addGatewayEndpoint("DynamoDbEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Security Group for Fargate tasks
    this.fargateSecurityGroup = new ec2.SecurityGroup(this, "FargateSG", {
      vpc: this.vpc,
      description: "Security group for OpenClaw Fargate tasks",
      allowAllOutbound: true,
    });

    this.fargateSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(BRIDGE_PORT),
      "Allow Bridge HTTP traffic (Bearer token auth)",
    );

    this.fargateSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(UI_PROXY_PORT),
      "Allow UI proxy HTTP traffic (cookie auth)",
    );

    // Outputs
    new cdk.CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, "PublicSubnetIds", {
      value: this.vpc.publicSubnets.map((s) => s.subnetId).join(","),
    });
    new cdk.CfnOutput(this, "SecurityGroupId", {
      value: this.fargateSecurityGroup.securityGroupId,
    });
  }
}
