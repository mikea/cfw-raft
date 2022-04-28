# cfw-raft

## Commands

```bash
# create cluster
curl -H "Content-Type: application/json" -X POST -d '{"members": 5}' http://127.0.0.1:8787/counter/start

# save cluster id
export CLUSTER_ID="000000017fe34216a211428fbded6f1e171aba7fe41a1cec17622968f8a07fb1"


# create a cluster and save id:

export CLUSTER_ID=$(curl -H "Content-Type: application/json" -X POST -d '{"members": 5}' http://127.0.0.1:8787/counter/start | jq -r .clusterId) && echo $CLUSTER_ID
```
