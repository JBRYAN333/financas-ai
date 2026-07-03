# Firestore Schema

## /users/{userId}
```json
{
  "email": "user@gmail.com",
  "displayName": "Nome",
  "createdAt": Timestamp,
  "plan": "free" | "pro",
  "usage": {
    "aiCalls": 0,
    "transactions": 0,
    "month": "2026-07"
  }
}
```

## /users/{userId}/transactions/{transactionId}
```json
{
  "date": Timestamp,
  "description": "Compra no mercado",
  "value": 35.90,
  "type": "entrada" | "saida",
  "category": "alimentacao" | "transporte" | "moradia" | "renda" | "outros",
  "createdAt": Timestamp
}
```
