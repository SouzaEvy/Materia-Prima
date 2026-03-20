# 🍽 Controle de Matéria-Prima — Restaurante

Sistema interno para controle de consumo de ingredientes a partir de saídas semanais (sem custos monetários — apenas quantidades em kg).

---

## 🚀 Configuração em 5 Passos

### 1. Criar projeto gratuito no Supabase

1. Acesse [app.supabase.com](https://app.supabase.com) → **New project**
2. Anote a **Project URL** e a chave **service_role** em:
   > Settings → API → Project API keys

### 2. Criar as tabelas (cole no SQL Editor do Supabase)

```sql
-- Habilitar extensão de UUID
create extension if not exists "uuid-ossp";

-- Receitas (pratos)
create table if not exists recipes (
  id           uuid primary key default uuid_generate_v4(),
  name         text unique not null,
  created_at   timestamptz default now()
);

-- Ingredientes por receita
create table if not exists recipe_ingredients (
  id                uuid primary key default uuid_generate_v4(),
  recipe_id         uuid references recipes(id) on delete cascade,
  ingredient        text not null,
  grams_per_portion integer not null,
  created_at        timestamptz default now()
);

-- Semanas processadas
create table if not exists weeks (
  id             uuid primary key default uuid_generate_v4(),
  week_code      text unique not null,
  total_portions integer not null default 0,
  created_at     timestamptz default now()
);

-- Registros de consumo por semana
create table if not exists consumption_records (
  id          uuid primary key default uuid_generate_v4(),
  week_id     uuid references weeks(id) on delete cascade,
  ingredient  text not null,
  kg          numeric not null,
  created_at  timestamptz default now()
);

-- RLS (acesso via service_role key no backend)
alter table recipes              enable row level security;
alter table recipe_ingredients   enable row level security;
alter table weeks                enable row level security;
alter table consumption_records  enable row level security;

create policy "full access recipes"             on recipes             for all using (true) with check (true);
create policy "full access recipe_ingredients"  on recipe_ingredients  for all using (true) with check (true);
create policy "full access weeks"               on weeks               for all using (true) with check (true);
create policy "full access consumption_records" on consumption_records  for all using (true) with check (true);
```

### 3. Configurar variáveis de ambiente

```bash
cp .env.example .env
# Edite .env com sua SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY
```

### 4. Instalar dependências

```bash
npm install
```

### 5. Rodar em desenvolvimento

```bash
npm run dev
# Abra http://localhost:3000
```

---

## 📁 Formatos de CSV

### Fichas Técnicas (receitas)

```csv
Prato;Ingrediente;GramasPorPorcao
Medalhão ao Madeira;Filé Mignon;240
Medalhão ao Madeira;Batata;150
Medalhão ao Madeira;Manteiga;20
Filé à Parmegiana;Frango;200
Filé à Parmegiana;Molho de Tomate;120
```

### Saídas Semanais (vendas/produção)

```csv
Data;Prato;Quantidade
15/03/2026;Medalhão ao Madeira;12
15/03/2026;Filé à Parmegiana;8
16/03/2026;Medalhão ao Madeira;15
```

> ✅ Separador `;` ou `,` é detectado automaticamente.  
> ✅ Semanas são agrupadas por número ISO (ex: `2026-W11`).

---

## 🔌 Endpoints da API

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/recipes/upload` | Upload do CSV de fichas técnicas |
| GET  | `/api/recipes` | Lista todos os pratos |
| GET  | `/api/recipes/list` | Lista ingredientes (tabela plana) |
| POST | `/api/weeks/upload` | Upload do CSV de saídas semanais |
| GET  | `/api/weeks` | Lista todas as semanas |
| GET  | `/api/weeks/:weekCode` | Detalhe de uma semana específica |
| GET  | `/api/dashboard` | Dados do painel principal |
| DELETE | `/api/all` | Apaga todos os dados |

---

## 🏗 Estrutura do Projeto

```
controle-materia-prima/
├── .env.example
├── package.json
├── tsconfig.json
├── src/
│   └── server.ts        ← Backend Express + TypeScript
├── public/
│   └── index.html       ← Frontend completo (single file)
└── uploads/             ← Pasta temporária para uploads (limpa automaticamente)
```
