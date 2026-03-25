import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const allowedEmail = process.env.ALLOWED_SIGNUP_EMAIL;
    const selfSignUpEnabled = !!allowedEmail;

    // Pre sign-up trigger: validates email against ALLOWED_EMAIL_PATTERN (exact or wildcard, e.g. *@example.com)
    const preSignUpFn = allowedEmail
      ? new lambda.Function(this, "PreSignUpFn", {
          runtime: lambda.Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const email = (event.request.userAttributes.email || "").toLowerCase();
  const pattern = (process.env.ALLOWED_EMAIL_PATTERN || "").toLowerCase();
  const matches = pattern.startsWith("*@")
    ? email.endsWith(pattern.slice(1))
    : email === pattern;
  if (!matches) throw new Error("Sign-up not permitted for this email address.");
  return event;
};`),
          environment: { ALLOWED_EMAIL_PATTERN: allowedEmail },
        })
      : undefined;

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "serverless-openclaw-users",
      selfSignUpEnabled,
      lambdaTriggers: preSignUpFn ? { preSignUp: preSignUpFn } : undefined,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = this.userPool.addClient("SpaClient", {
      userPoolClientName: "serverless-openclaw-spa",
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ["http://localhost:5173/callback", "https://app.example.com/callback"],
        logoutUrls: ["http://localhost:5173/", "https://app.example.com/"],
      },
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      idTokenValidity: cdk.Duration.hours(1),
    });

    this.userPoolDomain = this.userPool.addDomain("Domain", {
      cognitoDomain: {
        domainPrefix: `serverless-openclaw-${cdk.Aws.ACCOUNT_ID}`,
      },
    });

    // Outputs
    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: this.userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "UserPoolDomainName", {
      value: this.userPoolDomain.domainName,
    });
  }
}
