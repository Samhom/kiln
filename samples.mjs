export const samples = {
  order: {
    label: '订单',
    mode: 'view',
    view: 'table',
    filter: '.items[] | select(.price >= 80)',
    a: `{
  "orderId": "K24091",
  "status": "paid",
  "buyer": {
    "name": "林夏",
    "city": "杭州"
  },
  "items": [
    {"sku": "cup-ash", "name": "灰釉杯", "price": 128, "qty": 2, "status": "ready"},
    {"sku": "bowl-ember", "name": "赤泥碗", "price": 86, "qty": 1, "status": "ready"},
    {"sku": "lid-crack", "name": "开片盖", "price": 46, "qty": 4, "status": "backorder"}
  ],
  "paidAt": "2026-11-05T09:40:00+08:00",
  "note": null
}
`
  },
  log: {
    label: '日志',
    mode: 'view',
    view: 'table',
    filter: '.[] | select(.status >= 500)',
    a: `{"ts":"2026-11-05T09:01:02+08:00","path":"/orders","status":200,"ms":42}
{"ts":"2026-11-05T09:01:05+08:00","path":"/orders","status":500,"ms":910}
{"ts":"2026-11-05T09:01:09+08:00","path":"/health","status":200,"ms":6}
{"ts":"2026-11-05T09:01:11+08:00","path":"/orders/K24091","status":200,"ms":38}
`
  },
  config: {
    label: '两份配置',
    mode: 'compare',
    view: 'diff',
    filter: '',
    a: `{
  "kiln": "east",
  "cone": 6,
  "holdMinutes": 20,
  "glazes": ["ash", "celadon"],
  "note": "first firing"
}
`,
    b: `{
  "kiln": "east",
  "cone": 7,
  "holdMinutes": 15,
  "glazes": ["ash", "tenmoku"],
  "vent": true
}
`
  }
};
