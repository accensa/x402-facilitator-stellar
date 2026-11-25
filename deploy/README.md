# Deployment Guide

This directory contains deployment manifests for running the x402 facilitator on Kubernetes.

## Custom Metric Autoscaling (HPA) & Prometheus Adapter

In `deploy/kubernetes/active-verifications-hpa.yaml:18`, the `HorizontalPodAutoscaler` scales the `x402-facilitator` deployment based on the custom external metric `active_verifications`:

```yaml
metrics:
  - type: External
    external:
      metric:
        name: active_verifications
      target:
        type: AverageValue
        averageValue: '5'
```

This metric can only be resolved by the Kubernetes Custom Metrics API if the Prometheus Adapter configured in `deploy/kubernetes/prometheus-adapter-values.yaml:14` is installed and scraping facilitator metrics from `/metrics`.

### Required Installation Order

1. **Install Prometheus Adapter**:
   The adapter must be deployed before applying the HPA manifest so that the custom metrics API endpoint is available:
   ```bash
   helm upgrade --install prometheus-adapter prometheus-community/prometheus-adapter \
     --namespace monitoring --create-namespace \
     -f deploy/kubernetes/prometheus-adapter-values.yaml
   ```

2. **Verify Custom Metrics API Endpoint**:
   Check that the external metrics API responds and exposes the `active_verifications` metric:
   ```bash
   kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1"
   ```

3. **Apply the Facilitator Deployment and HPA**:
   Once the adapter is serving metrics, deploy the facilitator and apply the HPA:
   ```bash
   kubectl apply -f deploy/kubernetes/active-verifications-hpa.yaml
   ```

### Diagnostic Guidance

If an operator applies `deploy/kubernetes/active-verifications-hpa.yaml` standalone without installing or configuring the Prometheus Adapter, `kubectl describe hpa x402-facilitator` will show an error such as:

```text
unable to fetch metrics: the server could not find the requested resource
```
or:
```text
failed to get active_verifications external metric: unable to fetch metrics from external metrics API
```

To resolve this issue:
- Verify the Prometheus Adapter is running: `kubectl get pods -n monitoring -l app.kubernetes.io/name=prometheus-adapter`
- Verify the Prometheus Adapter values match `deploy/kubernetes/prometheus-adapter-values.yaml:14`.
- Verify the Prometheus server is successfully scraping `active_verifications` from the facilitator's `/metrics` endpoint.
- Verify `kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1"` lists `active_verifications`.
