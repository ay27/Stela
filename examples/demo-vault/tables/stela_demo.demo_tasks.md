# `stela_demo`.`demo_tasks`

> 由 Stela 自动生成于 2026-06-28T22:33:04+08:00 · 连接：`local-mysql`

```sql
CREATE TABLE `demo_tasks` (
  `id` int NOT NULL,
  `name` varchar(128) NOT NULL,
  `status` varchar(16) NOT NULL,
  `owner` varchar(64) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
```
