# Cost Optimization Analysis

## Summary

Aggressive cost optimization applied using the Fargate Spot + API Gateway combination:

| Category | Within Free Tier (12 months) | After Free Tier Expiration |
|----------|------------------------------|---------------------------|
| **Before Optimization** (Fargate On-Demand) | ~$3-5/month | ~$5-10/month |
| **After Optimization** (Fargate Spot + SSM) | **~$0.27/month** | **~$1.11/month** |
| **Savings Rate** | ~97% | ~80% |

---

## 1. Fargate Spot vs On-Demand Comparison

### Price Comparison (us-east-1)

| Resource | On-Demand | Fargate Spot | Discount Rate |
|----------|-----------|-------------|---------------|
| vCPU | $0.04048/hour | $0.01244/hour | **~70%** |
| Memory (GB) | $0.00445/hour | $0.00137/hour | **~70%** |

### Monthly Cost Calculation (0.25 vCPU, 1GB, 2 hours/day)

**Usage Hours**: 2 hours/day x 30 days = 60 hours/month

| Item | On-Demand | Fargate Spot |
|------|-----------|-------------|
| vCPU (0.25) | $0.61 | **$0.19** |
| Memory (1GB) | $0.27 | **$0.08** |
| **Subtotal** | **$0.88** | **$0.27** |

### Fargate Spot Caveats

- **2-minute advance warning**: AWS notifies 2 minutes before capacity reclamation
- **No SLA**: No availability guarantee
- **Interruption handling required**: Graceful shutdown implementation is mandatory

### Spot Interruption Response Strategy

OpenClaw's on-demand nature is a good fit for Spot:
1. **Automatic conversation state saving**: Real-time state persistence to DynamoDB enables recovery after interruptions
2. **Graceful shutdown**: Complete current work and save state within 2 minutes of receiving SIGTERM
3. **Automatic restart**: New Spot task automatically starts on the next request after interruption
4. **No fallback needed**: For personal use, a brief wait and reconnection is sufficient

---

## 2. API Gateway vs ALB Comparison

### Price Comparison (10,000 requests/month + WebSocket)

| Item | API Gateway | ALB |
|------|-------------|-----|
| Fixed cost | $0 | ~$16-18 ($0.0225/hour x 730 hours) |
| Request cost (REST 10K) | ~$0.035 | ~$0.08 (LCU) |
| WebSocket | ~$0.01 (messages + connection minutes) | Included in LCU |
| Data transfer | ~$0.01 | ~$0.01 |
| **Monthly total** | **~$0.05** | **~$18-25** |
| **Free Tier** | 1M REST requests + 1M WebSocket messages free | No Free Tier (WebSocket) |

### Conclusion

For personal use (low-traffic) environments, API Gateway saves **~$18-25/month** compared to ALB. API Gateway is overwhelmingly advantageous at low traffic volumes.

---

## 3. Detailed Cost by Service (After Optimization)

### Assumptions
- Region: us-east-1
- Fargate Spot: 0.25 vCPU, 1GB, 2 hours/day (public subnet, Public IP assigned)
- 10,000 requests/month, 10 concurrent WebSocket connections, average 30 minutes of daily use
- DynamoDB: 100K reads/writes per month
- No NAT Gateway (direct internet access via Fargate Public IP)
- VPC Gateway Endpoints: DynamoDB, S3 (free)
- S3: Under 1GB

### Within Free Tier (First 12 Months After Signup)

| Service | Monthly Cost | Notes |
|---------|-------------|-------|
| ECS Fargate Spot | **$0.27** | Fargate has no separate Free Tier |
| API Gateway (WebSocket + REST) | $0.00 | 1M requests + 1M messages Free Tier |
| DynamoDB | $0.00 | 25GB storage + 25 RCU/WCU Free Tier |
| S3 | $0.00 | 5GB Free Tier |
| CloudFront | $0.00 | 1TB transfer + 10M requests Free Tier |
| Cognito | $0.00 | 50,000 MAU always free |
| CloudWatch | $0.00 | 5GB log ingestion Free Tier |
| ECR | $0.00 | 500MB storage Free Tier |
| Secrets (SSM SecureString) | $0.00 | Standard parameters are free |
| VPC (Network) | $0.00 | No NAT Gateway, VPC Gateway Endpoints are free |
| **Total** | **~$0.27/month** | |

### After Free Tier Expiration

| Service | Monthly Cost | Calculation Basis |
|---------|-------------|-------------------|
| ECS Fargate Spot | **$0.27** | vCPU: 0.25 x $0.01244 x 60h = $0.19, Mem: 1 x $0.00137 x 60h = $0.08 |
| API Gateway REST | $0.04 | 10K requests x $3.50/1M = $0.035 |
| API Gateway WebSocket | $0.01 | 10K messages + ~13,500 connection minutes = ~$0.01 |
| DynamoDB | $0.16 | 100K reads($0.025) + 100K writes($0.125) + 1GB storage($0.01) |
| S3 | $0.03 | 1GB x $0.023 + request costs |
| CloudFront | $0.09 | 1GB transfer($0.085) + 10K requests($0.01) |
| Cognito | $0.00 | 50,000 MAU always free |
| CloudWatch | $0.50 | 1GB log ingestion($0.50) |
| ECR | $0.01 | ~100MB Docker image |
| Secrets (SSM SecureString) | $0.00 | Standard parameters are free |
| VPC (Network) | $0.00 | No NAT Gateway, VPC Gateway Endpoints are free |
| **Total** | **~$1.11/month** | |

---

## 4. Optimization Savings Summary vs On-Demand

```
Before Optimization (assuming Fargate On-Demand + ALB + Secrets Manager):
  Fargate On-Demand:  $0.88/month
  ALB:               $18.00/month
  Secrets Manager:    $2.00/month  (5 secrets x $0.40)
  Other:              $1.00/month
  Total:             ~$21.88/month

After Optimization (Fargate Spot + API Gateway + SSM SecureString):
  Fargate Spot:       $0.27/month
  API Gateway:        $0.05/month
  SSM SecureString:   $0.00/month  (standard parameters are free)
  Other:              $0.79/month
  Total:             ~$1.11/month

Savings: ~$20.77/month (~95% reduction)
```

---

## 5. Network Cost Optimization: Eliminating NAT Gateway

NAT Gateway incurs fixed costs even when idle, making it the largest cost driver in low-traffic personal use environments.

| Configuration | Monthly Fixed Cost | Data Processing | Notes |
|---------------|-------------------|-----------------|-------|
| NAT Gateway (single AZ) | ~$4.50 | $0.045/GB | Minimum ~$33/month (typical usage pattern) |
| NAT Instance (fck-nat) | ~$3.00 | Included in instance | Increased management overhead |
| **Fargate Public IP** | **$0** | **$0** | **Adopted** |

**Adopted Approach**: Place Fargate in a public subnet and assign a Public IP for direct internet access. NAT Gateway is completely eliminated.

- VPC Gateway Endpoints (DynamoDB, S3): Free. Keeps AWS service traffic on the internal network
- Interface Endpoints (ECR, CloudWatch, etc.): Not used. At ~$7/month each, they exceed cost targets. Fargate Public IP accesses public endpoints instead
- Lambda: Deployed outside VPC. Uses public AWS API endpoints

> **Tradeoff**: The Bridge server (`:8080`) is exposed to the internet, so shared secret token-based authentication is mandatory. Security Groups alone cannot identify Lambda's variable IP addresses.

---

## 6. Secrets Manager → SSM Parameter Store Migration

AWS Secrets Manager charges $0.40/secret/month. With 5 secrets, this adds **$2.00/month** — nearly doubling the total infrastructure cost. SSM Parameter Store SecureString (standard tier) is **free**, providing identical functionality for secret storage.

| Item | Secrets Manager | SSM SecureString |
|------|----------------|-----------------|
| Storage cost | $0.40/secret/month | $0 (standard tier) |
| 5 secrets total | **$2.00/month** | **$0.00/month** |
| API call cost | $0.05/10K calls | $0.05/10K calls (higher throughput free) |
| Encryption | AWS KMS (default key) | AWS KMS (default `aws/ssm` key) |
| ECS integration | `ecs.Secret.fromSecretsManager()` | `ecs.Secret.fromSsmParameter()` |
| Lambda integration | `{{resolve:secretsmanager:...}}` | `{{resolve:ssm-secure:...}}` |

**Migration impact**: Zero runtime changes. Both mechanisms inject secrets as plaintext environment variables. Container and Lambda code reads `process.env.*` identically regardless of the backing store.

---

## 7. Additional Cost Optimization Options

| Strategy | Savings Impact | Tradeoff |
|----------|---------------|----------|
| **Reduce Fargate specs** (0.25 vCPU, 1GB -> maintain minimum) | Already at minimum specs | May limit OpenClaw performance |
| **Shorten inactivity timeout** (15 min -> 5 min) | ~30% reduction in container runtime | Increased cold start frequency |
| **Shorten CloudWatch log retention period** | Log storage cost savings | Limited debugging history |
| **S3 Intelligent-Tiering** | Automatic cost reduction for inactive data | Negligible impact under 1GB |
| **Compute Savings Plans** (1-year commitment) | Additional 50% discount on Fargate | Long-term commitment required |
| **Predictive Pre-Warming** (EventBridge cron) | Eliminates ~68s cold start (0s first response) | Increased Fargate runtime (~$0.003/hr per pre-warmed container). Disabled by default |

### Predictive Pre-Warming Cost Impact

Pre-warming starts a Fargate container proactively before users send messages, trading a small cost increase for zero cold start latency. Disabled by default.

**Configuration:**

```bash
# .env
PREWARM_SCHEDULE=0 9 ? * MON-FRI *    # Weekdays at 9 AM UTC
PREWARM_DURATION=60                     # Keep container alive for 60 minutes
```

**Cost estimate** (1 vCPU, 2GB, Fargate Spot, ap-northeast-2):

| Scenario | Additional Fargate Hours | Additional Cost |
|----------|------------------------|-----------------|
| 1 hour/day, weekdays only | ~22 hours/month | ~$0.07/month |
| 2 hours/day, every day | ~60 hours/month | ~$0.19/month |
| 8 hours/day, weekdays only | ~176 hours/month | ~$0.55/month |

> Pre-warming cost is negligible (~$0.003/hour on Spot) compared to the UX improvement. If the user would have triggered a cold start anyway, the pre-warmed container is claimed and no additional cost is incurred.

**When to enable:**
- You have predictable usage patterns (e.g., work hours)
- Cold start latency (~68s) is unacceptable for your workflow
- The additional Fargate cost (~$0.003/hr) is acceptable

**When NOT to enable:**
- Unpredictable or very infrequent usage
- Cost must stay at absolute minimum

---

## 8. Alternative Reviewed but Not Adopted: Lambda Containers

> **Update (2026-03-15)**: This analysis was superseded by Phase 2 Lambda Container Migration. OpenClaw's `runEmbeddedPiAgent()` runs directly in Lambda without the Gateway server, achieving 1.35s cold start and $0 idle cost. See [Lambda Migration Journey](lambda-migration-journey.md) for details.

Using container-based Lambda instead of ECS Fargate Spot was evaluated but not adopted due to incompatibility with OpenClaw's characteristics.

### Lambda Container Image Key Limitations

| Item | Lambda Container | Fargate Spot |
|------|-----------------|-------------|
| Maximum execution time | **15 minutes (hard limit)** | Unlimited |
| Maximum image size | 10GB | Unlimited |
| Maximum memory | 10,240MB | Configurable |
| WebSocket support | Not possible (stateless) | Native support |
| Persistent process | Not possible (single execution per request) | Possible |
| Cold start | ~1 second (after caching) | ~30s-1min |

### Cost Comparison (2 hours of continuous execution per day)

| Item | Lambda Container | Fargate Spot |
|------|-----------------|-------------|
| Compute cost | ~$3.60 (216K GB-seconds x $0.0000167) | **~$0.23** |
| Request cost | ~$1.62 (after Free Tier exhaustion) | $0 |
| **Monthly total** | **~$5.22** | **~$0.23** |

Fargate Spot is **22x cheaper**.

### Reasons for Not Adopting

1. **15-minute timeout**: OpenClaw is a long-running agent. Conversation sessions, browser automation, and complex tasks can exceed 15 minutes
2. **No WebSocket support**: Lambda cannot maintain persistent connections. Lambda Web Adapter also only operates on a per-HTTP-request basis and does not support WebSocket
3. **Actually more expensive**: For long continuous execution, GB-second billing is more expensive than Fargate Spot
4. **No persistent processes**: Lambda runs in per-request isolation. OpenClaw's in-memory state (skill loading, conversation context) would need to be reconstructed with every request

### Hybrid Approach Also Evaluated

A hybrid approach routing simple chats to Lambda (instant response) and long-running tasks to Fargate was also evaluated, but:
- The savings are negligible ($0.23/month or less) relative to the additional implementation complexity (routing logic, state serialization, managing two runtimes)
- Some requests are unpredictable in whether they will exceed 15 minutes
- **Conclusion**: Insufficient cost/UX benefit relative to implementation complexity; maintaining Fargate Spot as the sole runtime

### Where Lambda Is Appropriate

In the current architecture, Lambda is used in the **Gateway role** (authentication, routing, container management), which is an optimal fit:
- Short execution times (hundreds of ms)
- Event-driven processing
- Free operation within the Free Tier

### References

- [AWS Lambda Container Image Support](https://aws.amazon.com/blogs/aws/new-for-aws-lambda-container-image-support/)
- [Lambda Container Images Documentation](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)
- [Lambda Pricing](https://aws.amazon.com/lambda/pricing/)
- [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter)
- [Lambda Response Streaming](https://aws.amazon.com/blogs/compute/using-response-streaming-with-aws-lambda-web-adapter-to-optimize-performance/)

---

## 9. Lambda Agent Cost (Phase 2)

With `AGENT_RUNTIME=lambda`, all fixed compute costs are eliminated.

| Component | Monthly Cost |
|-----------|-------------|
| Lambda execution (100 req × 1.5s × 2048MB) | ~$0.005 |
| S3 session storage | ~$0.01 |
| DynamoDB (session lock) | ~$0.001 |
| ECR image storage | ~$0.10 |
| **Total** | **~$0.12** |

Compared to Fargate (~$15/month idle), Lambda reduces compute costs by **99%** for low-usage scenarios.

---

## References

- [AWS Fargate Pricing](https://aws.amazon.com/fargate/pricing/)
- [Fargate Spot vs On-Demand - CloudZero](https://www.cloudzero.com/blog/fargate-cost/)
- [Fargate Pricing Deep Dive - Vantage](https://www.vantage.sh/blog/fargate-pricing)
- [Fargate Pricing Explained - CloudChipr](https://cloudchipr.com/blog/aws-fargate-pricing)
- [Fargate Pricing Guide - CloudExMachina](https://www.cloudexmachina.io/blog/fargate-pricing)
- [AWS API Gateway Pricing](https://aws.amazon.com/api-gateway/pricing/)
- [API Gateway Pricing Explained - CloudZero](https://www.cloudzero.com/blog/aws-api-gateway-pricing/)
- [API Gateway Pricing - CostGoat](https://costgoat.com/pricing/amazon-api-gateway)
- [API Gateway Pricing - AWSForEngineers](https://awsforengineers.com/blog/aws-api-gateway-pricing-explained/)
