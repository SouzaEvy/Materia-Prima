/**
 * controle-materia-prima — Backend (Express + TypeScript + Supabase)
 *
 * ============================================================
 * SETUP INSTRUCTIONS
 * ============================================================
 *
 * 1. CREATE FREE SUPABASE PROJECT
 * → https://app.supabase.com  → New project
 *
 * 2. CREATE TABLES — paste this SQL in the Supabase SQL Editor:
 *
 * -- Enable UUID extension (usually already on)
 * create extension if not exists "uuid-ossp";
 *
 * create table if not exists recipes (
 * id           uuid primary key default uuid_generate_v4(),
 * name         text unique not null,
 * created_at   timestamptz default now()
 * );
 *
 * create table if not exists recipe_ingredients (
 * id                uuid primary key default uuid_generate_v4(),
 * recipe_id         uuid references recipes(id) on delete cascade,
 * ingredient        text not null,
 * grams_per_portion integer not null,
 * created_at        timestamptz default now()
 * );
 *
 * create table if not exists weeks (
 * id             uuid primary key default uuid_generate_v4(),
 * week_code      text unique not null,
 * total_portions integer not null default 0,
 * created_at     timestamptz default now()
 * );
 *
 * create table if not exists consumption_records (
 * id          uuid primary key default uuid_generate_v4(),
 * week_id     uuid references weeks(id) on delete cascade,
 * ingredient  text not null,
 * kg          numeric not null,
 * created_at  timestamptz default now()
 * );
 *
 * create table if not exists upload_logs (
 * id          uuid primary key default uuid_generate_v4(),
 * type        text not null,
 * filename    text not null,
 * week_code   text,
 * result      text,
 * created_at  timestamptz default now()
 * );
 *
 * -- RLS: disable for service_role (backend-only tool, no public access)
 * alter table recipes              enable row level security;
 * alter table recipe_ingredients   enable row level security;
 * alter table weeks                enable row level security;
 * alter table consumption_records  enable row level security;
 * alter table upload_logs          enable row level security;
 *
 * -- Allow all via service_role key (used only in backend)
 * create policy "service_role full access recipes" on recipes for all using (true) with check (true);
 * create policy "service_role full access recipe_ingredients" on recipe_ingredients for all using (true) with check (true);
 * create policy "service_role full access weeks" on weeks for all using (true) with check (true);
 * create policy "service_role full access consumption_records" on consumption_records for all using (true) with check (true);
 * create policy "service_role full access upload_logs" on upload_logs for all using (true) with check (true);
 *
 * 3. GET KEYS
 * → Supabase Dashboard → Settings → API
 * → Copy "Project URL" and "service_role" secret key
 *
 * 4. CREATE .env FILE in project root:
 * SUPABASE_URL=https://your-project-ref.supabase.co
 * SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
 * PORT=3000
 *
 * 5. INSTALL & RUN:
 * npm install
 * npm run dev
 * → open http://localhost:3000
 *
 * ============================================================
 */

import * as cheerio from 'cheerio';
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { parse } from 'csv-parse';
import { createClient } from '@supabase/supabase-js';
import { parse as parseDate, isValid } from 'date-fns';

// ── Environment ─────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌  SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios no arquivo .env');
  process.exit(1);
}

// ── Supabase client (service role — backend only) ────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ── Express setup ────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ── Configuração para o painel abrir na produção (Railway) ──
const publicPath = path.join(process.cwd(), 'public');
app.use(express.static(publicPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
}); 

// ── Multer (temp disk storage in /uploads) ───────────────────
// Configuração do Multer (O Porteiro)
const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }, // Aumentei o limite para 50MB (Excel costuma ser pesado)
  fileFilter: (_req, file, cb) => {
    const isCSV = file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv');
    const isPDF = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
    const isExcel = file.originalname.toLowerCase().endsWith('.xlsx') || file.originalname.toLowerCase().endsWith('.xlsm');
    
    // Se for CSV, PDF ou Excel, deixa entrar!
    if (isCSV || isPDF || isExcel) {
      cb(null, true);
    } else {
      cb(new Error('Formato inválido. Envie apenas .csv, .pdf, .xlsx ou .xlsm'));
    }
  },
});

// ── Helpers ──────────────────────────────────────────────────

/** Remove temp file silently */
function cleanFile(filepath: string): void {
  try { fs.unlinkSync(filepath); } catch { /* ignore */ }
}

/** Detect delimiter: semicolon or comma */
function detectDelimiter(line: string): ',' | ';' {
  const semis = (line.match(/;/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  return semis >= commas ? ';' : ',';
}

/** Parse a raw CSV buffer into string[][] rows */
async function parseCsvBuffer(
  buf: Buffer,
  delimiter: ',' | ';'
): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    parse(buf, {
      delimiter,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }, (err, records: string[][]) => {
      if (err) reject(err);
      else resolve(records);
    });
  });
}

/** Sunday-based week number for a Date object.
 * Week 1 = the week containing Jan 1 that starts on Sunday.
 * Returns "YYYY-Www" e.g. "2026-W12"
 */
function sundayWeekCode(d: Date): string {
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - d.getDay()); // d.getDay(): 0=Sun,1=Mon,...,6=Sat
  sunday.setHours(0, 0, 0, 0);

  const jan1 = new Date(sunday.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((sunday.getTime() - jan1.getTime()) / 864e5);
  const weekNum = Math.floor(dayOfYear / 7) + 1;
  const year = sunday.getFullYear();
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

// Returns current Sunday-based week string "YYYY-Www"
function getWeekToday(): string {
  return sundayWeekCode(new Date());
}

// ── Route: POST /api/recipes/upload ─────────────────────────
app.post(
  '/api/recipes/upload',
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: 'Nenhum arquivo enviado.' });
      return;
    }

    const filepath = req.file.path;

    try {
      const raw = fs.readFileSync(filepath);
      const firstLine = raw.toString('utf8').split('\n')[0] ?? '';
      const delimiter = detectDelimiter(firstLine);
      const rows = await parseCsvBuffer(raw, delimiter);

      if (rows.length === 0) {
        res.status(400).json({ error: 'Arquivo CSV vazio.' });
        return;
      }

      // Detect if first row is a header
      let dataRows = rows;
      const firstDataRow = rows[0];
      if (firstDataRow && isNaN(Number(firstDataRow[2]))) {
        dataRows = rows.slice(1);
      }

      const dishMap = new Map<string, { ingredient: string; grams: number }[]>();

      for (const row of dataRows) {
        if (row.length < 3) continue;
        const dish = row[0].trim();
        const ingredient = row[1].trim();
        const grams = parseInt(row[2].trim().replace(',', '.'), 10);

        if (!dish || !ingredient || isNaN(grams) || grams <= 0) continue;

        if (!dishMap.has(dish)) dishMap.set(dish, []);
        dishMap.get(dish)!.push({ ingredient, grams });
      }

      if (dishMap.size === 0) {
        res.status(400).json({
          error: 'Nenhum prato válido encontrado. Verifique o formato: Prato;Ingrediente;GramasPorPorcao',
        });
        return;
      }

      let upsertedDishes = 0;
      let totalIngredients = 0;

      for (const [dishName, ingredients] of dishMap) {
        const { data: recipe, error: recipeErr } = await supabase
          .from('recipes')
          .upsert({ name: dishName }, { onConflict: 'name' })
          .select('id')
          .single();

        if (recipeErr || !recipe) {
          throw new Error(`Erro ao salvar prato "${dishName}": ${recipeErr?.message}`);
        }

        await supabase.from('recipe_ingredients').delete().eq('recipe_id', recipe.id);

        const ingredientRows = ingredients.map(i => ({
          recipe_id: recipe.id,
          ingredient: i.ingredient,
          grams_per_portion: i.grams,
        }));

        const { error: ingErr } = await supabase.from('recipe_ingredients').insert(ingredientRows);

        if (ingErr) throw new Error(`Erro ao salvar ingredientes de "${dishName}": ${ingErr.message}`);

        upsertedDishes++;
        totalIngredients += ingredients.length;
      }

      try {
        await supabase.from('upload_logs').insert({
          type: 'fichas',
          filename: req.file.originalname,
          week_code: null,
          result: `${upsertedDishes} prato(s), ${totalIngredients} ingrediente(s)`,
        });
      } catch { /* ignore */ }

      res.json({
        success: true,
        message: `✅ ${upsertedDishes} prato(s) e ${totalIngredients} ingrediente(s) salvos com sucesso!`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido';
      res.status(500).json({ error: `Erro ao processar fichas: ${message}` });
    } finally {
      cleanFile(filepath);
    }
  }
);

// ── Route: POST /api/weeks/upload (CSV) ────────────────────────────
app.post(
  '/api/weeks/upload',
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: 'Nenhum arquivo enviado.' });
      return;
    }

    const filepath = req.file.path;

    try {
      const { count: recipeCount } = await supabase.from('recipes').select('id', { count: 'exact', head: true });
      if (!recipeCount || recipeCount === 0) {
        res.status(400).json({ error: '⚠️ Nenhuma ficha técnica encontrada! Suba as fichas técnicas primeiro.' });
        return;
      }

      const rawBuf = fs.readFileSync(filepath);
      let textUtf8: string;
      const b0 = rawBuf[0], b1 = rawBuf[1], b2 = rawBuf[2];

      if (b0 === 0xFF && b1 === 0xFE) {
        textUtf8 = rawBuf.slice(2).toString('utf16le');
      } else if (b0 === 0xFE && b1 === 0xFF) {
        const swapped = Buffer.alloc(rawBuf.length - 2);
        for (let i = 0; i < swapped.length; i += 2) {
          swapped[i] = rawBuf[i + 3];
          swapped[i + 1] = rawBuf[i + 2];
        }
        textUtf8 = swapped.toString('utf16le');
      } else if (b0 === 0xEF && b1 === 0xBB && b2 === 0xBF) {
        textUtf8 = rawBuf.slice(3).toString('utf8');
      } else {
        const asUtf8 = rawBuf.toString('utf8');
        textUtf8 = asUtf8.includes('\uFFFD') ? Buffer.from(rawBuf.toString('latin1'), 'latin1').toString('utf8') : asUtf8;
      }

      textUtf8 = textUtf8.replace(/\u0000/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

      const firstLine = textUtf8.split('\n')[0] ?? '';
      const delimiter = detectDelimiter(firstLine);
      const rows = await parseCsvBuffer(Buffer.from(textUtf8), delimiter);

      if (rows.length === 0) {
        res.status(400).json({ error: 'Arquivo CSV vazio.' });
        return;
      }

      const headerRow = rows[0].map(h => h.toLowerCase().trim().replace(/[^a-z_]/g, ''));
      const colDescricao = headerRow.indexOf('descricao');
      const colQtd       = headerRow.findIndex(h => h === 'qtd');
      const isPdvFormat  = colDescricao >= 0 && colQtd >= 0;

      const useColDesc = isPdvFormat ? colDescricao : 1;
      const useColQtd  = isPdvFormat ? colQtd       : 2;
      const dataRows   = rows.slice(1);

      const weekCode: string = (typeof req.query.weekCode === 'string' && req.query.weekCode.match(/^\d{4}-W\d{2}$/))
          ? req.query.weekCode
          : getWeekToday();

      const { data: allIngredients, error: fetchErr } = await supabase
        .from('recipe_ingredients')
        .select('ingredient, grams_per_portion, recipes(name)');

      if (fetchErr) throw new Error(`Erro ao buscar receitas: ${fetchErr.message}`);

      const recipeIngMap = new Map<string, { ingredient: string; grams: number }[]>();

      for (const row of (allIngredients ?? [])) {
        const recipesField = row.recipes as unknown as { name: string } | { name: string }[] | null;
        if (!recipesField) continue;
        const recipeName = Array.isArray(recipesField) ? recipesField[0]?.name : recipesField.name;
        if (!recipeName) continue;
        const key = recipeName.toLowerCase().trim();
        if (!recipeIngMap.has(key)) recipeIngMap.set(key, []);
        recipeIngMap.get(key)!.push({ ingredient: String(row.ingredient), grams: Number(row.grams_per_portion) });
      }

      let totalPortions = 0;
      const ingredientTotals: Record<string, number> = {};
      const matchedDishes = new Set<string>();
      let skippedCount = 0;

      for (const row of dataRows) {
        if (row.length <= Math.max(useColDesc, useColQtd)) continue;
        const dishName = (row[useColDesc] ?? '').trim();
        const qty      = parseFloat((row[useColQtd] ?? '0').trim().replace(',', '.'));

        if (!dishName || isNaN(qty) || qty <= 0) continue;
        const recipe = recipeIngMap.get(dishName.toLowerCase());

        if (!recipe) { skippedCount++; continue; }

        totalPortions += qty;
        matchedDishes.add(dishName);

        for (const ing of recipe) {
          ingredientTotals[ing.ingredient] = (ingredientTotals[ing.ingredient] ?? 0) + (ing.grams * qty);
        }
      }

      if (Object.keys(ingredientTotals).length === 0) {
        res.status(400).json({ error: '⚠️ Nenhum prato com ficha técnica encontrado no arquivo.' });
        return;
      }

      const { data: weekRow, error: weekErr } = await supabase
        .from('weeks')
        .upsert({ week_code: weekCode, total_portions: totalPortions }, { onConflict: 'week_code' })
        .select('id')
        .single();

      if (weekErr || !weekRow) throw new Error(`Erro ao salvar semana: ${weekErr?.message}`);

      await supabase.from('consumption_records').delete().eq('week_id', weekRow.id);

      const records = Object.entries(ingredientTotals).map(([ingredient, grams]) => ({
        week_id: weekRow.id,
        ingredient,
        kg: parseFloat((grams / 1000).toFixed(4)),
      }));

      await supabase.from('consumption_records').insert(records);

      try {
        await supabase.from('upload_logs').insert({
          type: 'saidas',
          filename: req.file.originalname,
          week_code: weekCode,
          result: `${matchedDishes.size} pratos · ${totalPortions} porções · ${skippedCount} ignorados`,
        });
      } catch { /* ignore */ }

      res.json({
        success: true,
        message: `✅ Semana ${weekCode} salva! ${totalPortions} porções processadas.`,
      });

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido';
      res.status(500).json({ error: message });
    } finally {
      cleanFile(filepath);
    }
  }
);

// ── Route: POST /api/agile/webhook (HTML via Zapier) ───────────
// ── WEBHOOK AGILE PDV (Recebe o email do Zapier em HTML) ──
app.post('/api/agile/webhook', async (req: Request, res: Response) => {
  try {
    const { body_html, subject } = req.body;
    if (!body_html) return res.status(400).json({ error: 'Email HTML vazio' });

    const $ = cheerio.load(body_html);
    const rows: { descricao: string; qtd: number }[] = [];

    // Tenta extrair a data do Assunto do email
    const dateMatch = subject?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    
    // Se achar a data no email usa ela, senão usa o dia de hoje
    let reportCode = new Date().toISOString().split('T')[0]; 
    if (dateMatch) {
      reportCode = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
    }
    
    // O weekCode agora passa a ser a data exata do dia (Ex: 2026-03-23)
    const weekCode = reportCode;

    // 1. ISOLAR A TABELA CERTA (Produtos Vendidos Diários)
    // O Agile manda várias tabelas iguais (Top 20 mensal, etc). 
    // A tabela de vendas DIÁRIAS é SEMPRE a última do email!
    const productTables: any[] = [];
    
    $('table').each((_, table) => {
      const firstRow = $(table).find('tr').first().text().toLowerCase();
      const secondRow = $(table).find('tr').eq(1).text().toLowerCase();
      
      if (
        (firstRow.includes('produto') && firstRow.includes('quantidade')) ||
        (secondRow.includes('produto') && secondRow.includes('quantidade'))
      ) {
        productTables.push(table);
      }
    });

    if (productTables.length === 0) return res.status(400).json({ error: 'Nenhuma tabela de produtos encontrada.' });

    // Pega APENAS a última tabela
    const targetTable = productTables[productTables.length - 1]; 

    // Extrai os itens
    $(targetTable).find('tr').each((_, el) => {
      const cols = $(el).find('td');
      if (cols.length >= 2) {
        const descricao = $(cols[0]).text().trim();
        const qtd = parseFloat($(cols[1]).text().replace(',', '.'));
        
        if (descricao && descricao.toLowerCase() !== 'produto' && !isNaN(qtd) && qtd > 0) {
          rows.push({ descricao, qtd });
        }
      }
    });

    if (rows.length === 0) return res.status(400).json({ error: 'Nenhum produto encontrado na tabela diária' });

    // Busca fichas
    const { data: allIngredients } = await supabase.from('recipe_ingredients').select('ingredient, grams_per_portion, recipes(name)');
    const recipeIngMap = new Map<string, { ingredient: string; grams: number }[]>();

    for (const row of (allIngredients ?? [])) {
      const recipesField = row.recipes as unknown as { name: string } | { name: string }[] | null;
      if (!recipesField) continue;
      const recipeName = Array.isArray(recipesField) ? recipesField[0]?.name : recipesField.name;
      if (!recipeName) continue;
      
      const key = recipeName.toLowerCase().trim();
      if (!recipeIngMap.has(key)) recipeIngMap.set(key, []);
      recipeIngMap.get(key)!.push({ ingredient: String(row.ingredient), grams: Number(row.grams_per_portion) });
    }

    let dailyPortions = 0;
    const dailyIngredientTotals: Record<string, number> = {};
    let skipped = 0;

    for (const row of rows) {
      const recipe = recipeIngMap.get(row.descricao.toLowerCase());
      if (!recipe) { skipped++; continue; } // Ignora itens sem ficha
      
      dailyPortions += row.qtd;
      for (const ing of recipe) {
        dailyIngredientTotals[ing.ingredient] = (dailyIngredientTotals[ing.ingredient] ?? 0) + (ing.grams * row.qtd);
      }
    }

    if (Object.keys(dailyIngredientTotals).length === 0) return res.status(400).json({ error: 'Nenhum item vendido no dia possui ficha.' });

    // 2. LÓGICA DE SOMA (Acumular dias da semana)
    let { data: existingWeek } = await supabase.from('weeks').select('id, total_portions').eq('week_code', weekCode).single();
    
    let finalPortions = dailyPortions;
    let finalIngredientTotals = { ...dailyIngredientTotals };

    if (existingWeek) {
      // Se a semana já existe, soma as porções e os ingredientes
      finalPortions += existingWeek.total_portions;
      
      const { data: existingRecords } = await supabase.from('consumption_records').select('ingredient, kg').eq('week_id', existingWeek.id);
      
      (existingRecords ?? []).forEach(r => {
        const existingGrams = Number(r.kg) * 1000;
        finalIngredientTotals[r.ingredient] = (finalIngredientTotals[r.ingredient] ?? 0) + existingGrams;
      });
      
      // Limpa os antigos para inserir os dados somados
      await supabase.from('consumption_records').delete().eq('week_id', existingWeek.id);
    }

    // Salva a semana com a nova soma
    const { data: upsertedWeek } = await supabase.from('weeks').upsert({ week_code: weekCode, total_portions: finalPortions }, { onConflict: 'week_code' }).select('id').single();
    if (!upsertedWeek) throw new Error('Erro ao salvar semana');

    // Salva os ingredientes somados
    const newRecords = Object.entries(finalIngredientTotals).map(([ingredient, grams]) => ({
      week_id: upsertedWeek.id,
      ingredient,
      kg: parseFloat((grams / 1000).toFixed(4))
    }));

    await supabase.from('consumption_records').insert(newRecords);

    // Registra o upload automático
    await supabase.from('upload_logs').insert({
      type: 'agile_email',
      filename: `Email Automático: ${subject}`,
      week_code: weekCode,
      result: `Vendas do dia somadas! ${rows.length - skipped} itens c/ ficha (${skipped} ignorados).`
    });

    return res.json({ success: true, message: `Webhook processou as vendas do dia e atualizou a semana.` });

  } catch (err: any) {
    console.error("Erro no Webhook:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE Routes (Lixeiras) ─────────────────────────────────

// Deletar Ficha Técnica Específica
app.delete('/api/recipes/:name', async (req: Request, res: Response) => {
  try {
    const { error } = await supabase.from('recipes').delete().eq('name', req.params.name);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Deletar Semana Inteira (Saídas)
app.delete('/api/weeks/:weekCode', async (req: Request, res: Response) => {
  try {
    const { error } = await supabase.from('weeks').delete().eq('week_code', req.params.weekCode);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Deletar Registro de Upload (Aba Arquivos)
app.delete('/api/uploads/:id', async (req: Request, res: Response) => {
  try {
    const { error } = await supabase.from('upload_logs').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});


// ── Route: GET /api/weeks ────────────────────────────────────
app.get('/api/weeks', async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data: weeks, error: weeksErr } = await supabase
      .from('weeks')
      .select('id, week_code, total_portions, created_at')
      .order('week_code', { ascending: false });

    if (weeksErr) throw new Error(weeksErr.message);

    const weekIds = (weeks ?? []).map(w => w.id);
    let kgByWeek: Record<string, number> = {};

    if (weekIds.length > 0) {
      const { data: records, error: recErr } = await supabase.from('consumption_records').select('week_id, kg').in('week_id', weekIds);
      if (recErr) throw new Error(recErr.message);
      for (const r of records ?? []) { kgByWeek[r.week_id] = (kgByWeek[r.week_id] ?? 0) + Number(r.kg); }
    }

    const result = (weeks ?? []).map(w => ({
      id: w.id,
      week_code: w.week_code,
      total_portions: w.total_portions,
      total_kg: parseFloat((kgByWeek[w.id] ?? 0).toFixed(3)),
      created_at: w.created_at,
    }));

    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Route: GET /api/weeks/:weekCode ─────────────────────────
app.get('/api/weeks/:weekCode', async (req: Request, res: Response): Promise<void> => {
  const { weekCode } = req.params;
  try {
    const { data: week, error: weekErr } = await supabase.from('weeks').select('id, week_code, total_portions').eq('week_code', weekCode).single();
    if (weekErr || !week) return (res.status(404).json({ error: `Semana "${weekCode}" não encontrada.` }) as any);

    const { data: records, error: recErr } = await supabase.from('consumption_records').select('ingredient, kg').eq('week_id', week.id).order('kg', { ascending: false });
    if (recErr) throw new Error(recErr.message);

    const totalKg = (records ?? []).reduce((sum, r) => sum + Number(r.kg), 0);

    res.json({
      week_code: week.week_code,
      total_portions: week.total_portions,
      total_kg: parseFloat(totalKg.toFixed(3)),
      records: (records ?? []).map(r => ({ ingredient: r.ingredient, kg: parseFloat(Number(r.kg).toFixed(3)) })),
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Route: GET /api/recipes/list ─────────────────────────────
app.get('/api/recipes/list', async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase.from('recipe_ingredients').select('ingredient, grams_per_portion, recipes(name)').order('ingredient');
    if (error) throw new Error(error.message);

    const flat = (data ?? [])
      .map(r => {
        const recipesField = r.recipes as unknown as { name: string } | { name: string }[] | null;
        if (!recipesField) return null;
        const dishName = Array.isArray(recipesField) ? recipesField[0]?.name : recipesField.name;
        if (!dishName) return null;
        return { dish: dishName, ingredient: String(r.ingredient), grams_per_portion: Number(r.grams_per_portion) };
      })
      .filter((r): r is { dish: string; ingredient: string; grams_per_portion: number } => r !== null)
      .sort((a, b) => { const d = a.dish.localeCompare(b.dish); return d !== 0 ? d : a.ingredient.localeCompare(b.ingredient); });

    res.json(flat);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Route: DELETE /api/all ───────────────────────────────────
app.delete('/api/all', async (_req: Request, res: Response): Promise<void> => {
  try {
    await supabase.from('consumption_records').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('weeks').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('recipe_ingredients').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('recipes').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    res.json({ success: true, message: 'Todos os dados foram apagados.' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── WEBHOOK AGILE PDV (Recebe o email do Zapier em HTML) ──
app.post('/api/agile/webhook', async (req: Request, res: Response) => {
  try {
    const { body_html, subject } = req.body;
    if (!body_html) return res.status(400).json({ error: 'Email HTML vazio' });

    const $ = cheerio.load(body_html);
    const rows: { descricao: string; qtd: number }[] = [];

    // Tenta extrair a data do Assunto: "Resumo do movimento de 22/03/2026"
    const dateMatch = subject?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    let dateStr = new Date().toISOString().split('T')[0]; // Se não achar data, usa hoje
    if (dateMatch) dateStr = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
    
    // Calcula a semana de Domingo a Sábado (usando a mesma lógica do seu sistema)
    const mDate = new Date(dateStr + 'T12:00:00');
    const sunday = new Date(mDate);
    sunday.setDate(mDate.getDate() - mDate.getDay());
    sunday.setHours(0, 0, 0, 0);
    const jan1 = new Date(sunday.getFullYear(), 0, 1);
    const dayOfYear = Math.floor((sunday.getTime() - jan1.getTime()) / 864e5);
    const weekNum = Math.floor(dayOfYear / 7) + 1;
    const weekCode = `${sunday.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

    // Varre o HTML procurando a tabela de produtos e extrai as linhas (<tr>) e colunas (<td>)
    $('table.customTable tr, tr').each((_, el) => {
      const cols = $(el).find('td');
      if (cols.length >= 2) {
        const descricao = $(cols[0]).text().trim();
        const qtd = parseFloat($(cols[1]).text().replace(',', '.'));
        // Se achou uma descrição e uma quantidade válida, salva
        if (descricao && !isNaN(qtd) && qtd > 0) {
          rows.push({ descricao, qtd });
        }
      }
    });

    if (rows.length === 0) return res.status(400).json({ error: 'Nenhum produto encontrado no email' });

    // Busca todas as fichas no banco para cruzar os dados
    const { data: allIngredients } = await supabase.from('recipe_ingredients').select('ingredient, grams_per_portion, recipes(name)');
    const recipeIngMap = new Map<string, { ingredient: string; grams: number }[]>();

    for (const row of (allIngredients ?? [])) {
      const recipesField = row.recipes as unknown as { name: string } | { name: string }[] | null;
      if (!recipesField) continue;
      const recipeName = Array.isArray(recipesField) ? recipesField[0]?.name : recipesField.name;
      if (!recipeName) continue;
      
      const key = recipeName.toLowerCase().trim();
      if (!recipeIngMap.has(key)) recipeIngMap.set(key, []);
      recipeIngMap.get(key)!.push({ ingredient: String(row.ingredient), grams: Number(row.grams_per_portion) });
    }

    let totalPortions = 0;
    const ingredientTotals: Record<string, number> = {};
    let skipped = 0;

    // Cruza as vendas do email com as fichas técnicas
    for (const row of rows) {
      const recipe = recipeIngMap.get(row.descricao.toLowerCase());
      if (!recipe) { skipped++; continue; } // Ignora itens sem ficha (bebidas, entradas, etc)
      
      totalPortions += row.qtd;
      for (const ing of recipe) {
        ingredientTotals[ing.ingredient] = (ingredientTotals[ing.ingredient] ?? 0) + (ing.grams * row.qtd);
      }
    }

    if (Object.keys(ingredientTotals).length === 0) return res.status(400).json({ error: 'Nenhum item vendido possui ficha técnica.' });

    // Salva/Atualiza a Semana no Supabase
    const { data: weekRow } = await supabase.from('weeks').upsert({ week_code: weekCode, total_portions: totalPortions }, { onConflict: 'week_code' }).select('id').single();
    if (!weekRow) throw new Error('Erro ao criar ou atualizar a semana');

    // Limpa o consumo daquela semana e insere o novo recalculado
    await supabase.from('consumption_records').delete().eq('week_id', weekRow.id);

    const records = Object.entries(ingredientTotals).map(([ingredient, grams]) => ({
      week_id: weekRow.id,
      ingredient,
      kg: parseFloat((grams / 1000).toFixed(4))
    }));

    await supabase.from('consumption_records').insert(records);

    // Registra o sucesso na aba "Arquivos Enviados" (Logs)
    await supabase.from('upload_logs').insert({
      type: 'agile_email',
      filename: `Email Automático: ${subject}`,
      week_code: weekCode,
      result: `${rows.length - skipped} itens salvos · ${skipped} ignorados`
    });

    return res.json({ success: true, message: `Webhook processou semana ${weekCode} com sucesso.` });

  } catch (err: any) {
    console.error("Erro no Webhook:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Dashboard com Filtros ────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const months = parseInt(req.query.months as string) || 12;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);

    // Busca Semanas(Dias), Registros e Compras
    const { data: allWeeks } = await supabase.from('weeks').select('id, week_code, total_portions, created_at').order('week_code', { ascending: false });
    const { data: allRecords } = await supabase.from('consumption_records').select('week_id, ingredient, kg');
    const { data: allCompras } = await supabase.from('compras').select('valor_total, data_compra');

    // Filtra pelo período selecionado no dropdown
    const periodWeeks = (allWeeks ?? []).filter(w => {
      const d = w.week_code.match(/^\d{4}-\d{2}-\d{2}$/) ? new Date(w.week_code + 'T12:00:00') : new Date(w.created_at);
      return d >= cutoff;
    });

    const periodCompras = (allCompras ?? []).filter(c => {
      const d = new Date(c.data_compra + 'T12:00:00');
      return d >= cutoff;
    });

    const periodWeekIds = new Set(periodWeeks.map(w => w.id));
    const periodRecords = (allRecords ?? []).filter(r => periodWeekIds.has(r.week_id));

    // Cálculos do Dashboard
    const totalKg = periodRecords.reduce((s, r) => s + Number(r.kg), 0);
    const totalPortions = periodWeeks.reduce((s, w) => s + w.total_portions, 0);
    const totalCompras = periodCompras.reduce((s, c) => s + Number(c.valor_total || 0), 0); // Soma o valor em Reais

    const ingMap: Record<string, number> = {};
    for (const r of periodRecords) ingMap[r.ingredient] = (ingMap[r.ingredient] ?? 0) + Number(r.kg);
    const top5 = Object.entries(ingMap).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ingredient, kg]) => ({ ingredient, kg: parseFloat(kg.toFixed(3)) }));
    
    const { count: recipeCount } = await supabase.from('recipes').select('id', { count: 'exact', head: true });

    res.json({
      total_compras: totalCompras,
      total_kg: parseFloat(totalKg.toFixed(3)),
      total_portions: totalPortions,
      total_weeks: periodWeeks.length,
      recipe_count: recipeCount ?? 0,
      top5_ingredients: top5,
      recent_weeks: periodWeeks.slice(0, 4).map(w => {
        const kg = periodRecords.filter(r => r.week_id === w.id).reduce((s, r) => s + Number(r.kg), 0);
        return { week_code: w.week_code, total_portions: w.total_portions, total_kg: parseFloat(kg.toFixed(3)) };
      })
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Route: GET /api/reports (Relatório por Período de Datas Livre) ──
app.get('/api/reports', async (req, res) => {
  try {
    const { start, end } = req.query;
    let query = supabase.from('weeks').select('id, week_code, total_portions');
    
    // Aplica o filtro de data (maior que start, menor que end)
    if (start) query = query.gte('week_code', start);
    if (end) query = query.lte('week_code', end);
    
    const { data: weeks, error } = await query;
    if (error) throw error;

    if (!weeks || weeks.length === 0) {
      return res.json({ total_portions: 0, total_kg: 0, records: [] });
    }

    const weekIds = weeks.map(w => w.id);
    const { data: records } = await supabase.from('consumption_records').select('ingredient, kg').in('week_id', weekIds);

    let totalPortions = 0;
    let totalKg = 0;
    weeks.forEach(w => totalPortions += w.total_portions);

    const ingMap: Record<string, number> = {};
    (records || []).forEach(r => {
      ingMap[r.ingredient] = (ingMap[r.ingredient] || 0) + Number(r.kg);
      totalKg += Number(r.kg);
    });

    const finalRecords = Object.entries(ingMap)
      .map(([ingredient, kg]) => ({ ingredient, kg: parseFloat(kg.toFixed(3)) }))
      .sort((a,b) => b.kg - a.kg);

    res.json({ 
      total_portions: totalPortions, 
      total_kg: parseFloat(totalKg.toFixed(3)), 
      records: finalRecords 
    });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route: POST /api/compras/upload (Lê o PDF de Pedidos) ──
app.post('/api/compras/upload', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    return;
  }

  const filepath = req.file.path;

  try {
    const dataBuffer = fs.readFileSync(filepath);
    
    // 1. Carrega o módulo na versão 2.0+ 
    const pdfLib: any = require('pdf-parse');
    
    // 2. Extrai a Classe oficial 'PDFParse' do módulo
    const PDFParseClass = pdfLib.PDFParse || (pdfLib.default && pdfLib.default.PDFParse);
    
    if (!PDFParseClass) {
      throw new Error("Não foi possível encontrar a classe PDFParse na biblioteca.");
    }

    // 3. Inicializa o leitor e extrai o texto (Nova API)
    const parser = new PDFParseClass({ data: dataBuffer });
    const result = await parser.getText();
    const text = result.text || "";

    const comprasProcessadas: any[] = [];
    
    // Extrai a data do pedido do PDF (Ex: 23/03/2026)
    let dataPedido = new Date().toISOString().split('T')[0]; 
    const dataMatch = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (dataMatch) {
      dataPedido = `${dataMatch[3]}-${dataMatch[2]}-${dataMatch[1]}`;
    }

    // O "Leitor Inteligente" criado para o padrão da Vila Leopoldina
    const textoPlano = text.replace(/\n/g, ' ');

    // Busca exatamente o padrão: [Produto] R$ [ValorUn] [Qtd] R$ [Total]
    const regexPoderoso = /((?:(?!R\$).)+?)\s+R\$\s*([\d.,]+)\s+([\d.,]+)\s+R\$\s*([\d.,]+)/g;
    
    let match;
    while ((match = regexPoderoso.exec(textoPlano)) !== null) {
      let pedacos = match[1].split(/Total|Qtde|Observação/i);
      let nomeLimpo = pedacos[pedacos.length - 1].trim();
      
      nomeLimpo = nomeLimpo.replace(/Pedido nº.*?Realizado.*?(\d{2}-|[A-Z])/i, '$1').trim();
      if (nomeLimpo.length > 80) nomeLimpo = nomeLimpo.substring(nomeLimpo.length - 80).trim();

      // ── NOVA REGRA: MATA O FORNECEDOR ──
      // Procura o padrão "05-", "06-", etc. e corta tudo o que vem antes!
      const matchCodigo = nomeLimpo.match(/\b\d{2}\s?-/);
      if (matchCodigo) {
        nomeLimpo = nomeLimpo.substring(nomeLimpo.indexOf(matchCodigo[0]));
      }
      // ───────────────────────────────────

      const valorUn = parseFloat(match[2].replace(/\./g, '').replace(',', '.'));
      const qtd = parseFloat(match[3].replace(/\./g, '').replace(',', '.'));
      const valorTot = parseFloat(match[4].replace(/\./g, '').replace(',', '.'));

      if (nomeLimpo && qtd > 0) {
        comprasProcessadas.push({
          data_compra: dataPedido,
          produto: nomeLimpo,
          quantidade: qtd,
          valor_unitario: valorUn,
          valor_total: valorTot
        });
      }
    }
    if (comprasProcessadas.length === 0) {
      res.status(400).json({ error: 'Nenhum produto reconhecido. O layout do PDF não bate com o padrão esperado.' });
      return;
    }

    // Salva no banco de dados
    const { error: insertErr } = await supabase.from('compras').insert(comprasProcessadas);
    if (insertErr) throw new Error(insertErr.message);

    // Registra nos logs
    await supabase.from('upload_logs').insert({
      type: 'compras',
      filename: req.file.originalname,
      result: `${comprasProcessadas.length} produtos adicionados ao estoque.`
    });

    res.json({ success: true, message: `✅ ${comprasProcessadas.length} itens registrados no estoque!` });
  } catch (err: any) {
    console.error("Erro no Upload do PDF:", err);
    res.status(500).json({ error: err.message });
  } finally {
    cleanFile(filepath);
  }
});

// ── Route: GET /api/compras (Lista as compras) ──
app.get('/api/compras', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase.from('compras').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    res.json(data ?? []);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route: DELETE /api/compras/data/:data (Exclui todas as compras de um lote/dia) ──
app.delete('/api/compras/data/:data', async (req: Request, res: Response) => {
  try {
    const { error } = await supabase.from('compras').delete().eq('data_compra', req.params.data);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/compras/:id', async (req: Request, res: Response) => {
  try {
    const { error } = await supabase.from('compras').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route: GET /api/upload-logs ──────────────────────────────
app.get('/api/upload-logs', async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase.from('upload_logs').select('id, type, filename, week_code, result, created_at').order('created_at', { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    res.json(data ?? []);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Error middleware ─────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message ?? 'Erro interno do servidor' });
});

// Route: POST /api/inventario/upload (Lê os CSVs Semanai ou Quinzenais)

// ── INVENTÁRIO (CONTAGEM DE ESTOQUE) ──────────────────────────────────────

// ── INVENTÁRIO (CONTAGEM DE ESTOQUE) ──────────────────────────────────────

app.post('/api/inventario/upload', (req: Request, res: Response): void => {
  upload.array('files', 50)(req, res, async (multerErr: any) => {
    if (multerErr) {
      res.status(400).json({ error: 'Erro ao receber o arquivo: ' + multerErr.message });
      return;
    }

    if (!req.files || (req.files as Express.Multer.File[]).length === 0) {
      res.status(400).json({ error: 'Nenhum arquivo enviado.' });
      return;
    }

    const files = req.files as Express.Multer.File[];
    const inventarioProcessado: any[] = [];
    const fs = require('fs');

    try {
      const dataContagem = (typeof req.query.date === 'string' && req.query.date) ? req.query.date : new Date().toISOString().split('T')[0];
      const ExcelJS = require('exceljs');

      for (const file of files) {
        const fileBuffer = fs.readFileSync(file.path);
        const workbook = new ExcelJS.Workbook();
        
        await workbook.xlsx.load(fileBuffer);

        workbook.eachSheet((sheet: any) => {
          const rows: string[][] = [];
          
          // O SEGREDO AQUI: Pula linhas vazias e tem TRAVA de 2.000 linhas
          sheet.eachRow((row: any, rowNumber: number) => {
            if (rowNumber > 2000) return; // Evita o loop infinito do Excel

            const rowValues: string[] = [];
            // O ExcelJS guarda os valores num array. Nós extraímos direto (muito mais rápido)
            if (Array.isArray(row.values)) {
              for (let i = 1; i < row.values.length; i++) {
                const cellVal = row.values[i];
                let textVal = '';
                // Lê o texto ou o resultado da fórmula
                if (cellVal !== null && cellVal !== undefined) {
                   textVal = typeof cellVal === 'object' && cellVal.result !== undefined ? String(cellVal.result) : String(cellVal);
                }
                rowValues.push(textVal);
              }
            }
            rows.push(rowValues);
          });

          if (rows.length < 2) return;

          let colDesc = -1, colQtd = -1;
          let startRow = -1;

          // Procura o cabeçalho
          for (let i = 0; i < Math.min(30, rows.length); i++) {
            if (!rows[i]) continue;
            const rowLower = rows[i].map((c: string) => c.toLowerCase().trim().replace(/ç/g, 'c').replace(/ã/g, 'a').replace(/\./g, ''));
            
            // Padrão 1 (Semanal)
            if (rowLower.includes('descricao item') && (rowLower.includes('qt na emb'))) {
              colDesc = rowLower.findIndex((c: string) => c === 'descricao item');
              colQtd = rowLower.findIndex((c: string) => c.includes('qt na emb'));
              startRow = i + 1; break;
            }
            // Padrão 2 (Mensal)
            else if (rowLower.includes('codigo everest') && rowLower.includes('descricao') && rowLower.includes('quantidade')) {
              colDesc = rowLower.findIndex((c: string) => c === 'descricao');
              colQtd = rowLower.findIndex((c: string) => c === 'quantidade');
              startRow = i + 1; break;
            }
          }

          if (startRow === -1) return;

          // Extrai os produtos
          for (let i = startRow; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length <= Math.max(colDesc, colQtd)) continue;

            const produto = (row[colDesc] || '').trim();
            let quantidadeStr = (row[colQtd] || '0').trim();
            if (quantidadeStr.includes(',')) quantidadeStr = quantidadeStr.replace(/\./g, '').replace(',', '.');
            const quantidade = parseFloat(quantidadeStr);

            if (produto && !isNaN(quantidade) && quantidade > 0) {
              inventarioProcessado.push({
                data_contagem: dataContagem,
                produto: produto,
                quantidade: quantidade,
                unidade: '' 
              });
            }
          }
        });
      }

      if (inventarioProcessado.length === 0) {
        res.status(400).json({ error: 'Nenhum dado válido encontrado. O sistema ignorou as abas de resumo ou as tabelas vazias.' });
        return;
      }

      const { error: insertErr } = await supabase.from('inventario').insert(inventarioProcessado);
      if (insertErr) throw new Error(insertErr.message);

      await supabase.from('upload_logs').insert({ type: 'inventario', filename: `Planilha Excel`, result: `${inventarioProcessado.length} itens registrados.` });

      res.json({ success: true, message: `✅ Leitura concluída! ${inventarioProcessado.length} itens capturados com sucesso.` });
    } catch (err: any) {
      console.error("Erro interno no servidor:", err);
      // Devolve o erro para a tela caso o Excel esteja corrompido
      res.status(500).json({ error: 'Erro ao processar o arquivo: ' + err.message });
    } finally {
      files.forEach(file => {
        try { fs.unlinkSync(file.path); } catch(e) {}
      });
    }
  });
});

// Route: GET /api/inventario
app.get('/api/inventario', async (req, res) => {
  try {
    const { data, error } = await supabase.from('inventario').select('*').order('data_contagem', { ascending: false }).limit(400);
    if (error) throw new Error(error.message);
    res.json(data ?? []);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Route: DELETE /api/inventario/data/:data
app.delete('/api/inventario/data/:data', async (req, res) => {
  try {
    const { error } = await supabase.from('inventario').delete().eq('data_contagem', req.params.data);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Route: GET /api/inventario (Lista as contagens)
app.get('/api/inventario', async (req, res) => {
  try {
    const { data, error } = await supabase.from('inventario').select('*').order('data_contagem', { ascending: false }).limit(400);
    if (error) throw new Error(error.message);
    res.json(data ?? []);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Route: DELETE /api/inventario/data/:data (Exclui lote do inventário)
app.delete('/api/inventario/data/:data', async (req, res) => {
  try {
    const { error } = await supabase.from('inventario').delete().eq('data_contagem', req.params.data);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── ESTOQUE EM TEMPO REAL (CRUZAMENTO AUTOMÁTICO INTELIGENTE) ─────────────────────────

app.get('/api/estoque-atual', async (req: Request, res: Response) => {
  try {
    const { data: inventarios } = await supabase.from('inventario').select('*').order('data_contagem', { ascending: false });
    const { data: compras } = await supabase.from('compras').select('*');
    const { data: consumos } = await supabase.from('consumption_records').select('*');
    const { data: weeks } = await supabase.from('weeks').select('*');

    const weekDates: Record<number, string> = {};
    (weeks || []).forEach(w => weekDates[w.id] = w.week_code);

    // ── A MÁGICA DO PADRONIZADOR DE NOMES ──
    const normalizarNome = (nome: string) => {
      if (!nome) return 'DESCONHECIDO';
      let n = nome.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // Remove acentos
      n = n.replace(/[^\w\s]/gi, ' '); // Remove pontuação
      n = n.replace(/\b\d+\/\d+\b/g, ' '); // Remove frações tipo "4/5" ou "61/70"
      n = n.replace(/\b(\d+(KG|G|ML|L|LTS|UN|UNID|MM|UP)?)\b/g, ' '); // Remove pesos "1KG", "500G"
      // Remove adjetivos inúteis para o estoque
      n = n.replace(/\b(FRESCO|CONGELADO|RESFRIADO|LIMPO|IQF|PCT|PACOTE|CX|CAIXA|UNIDADE|KG|LITRO|GRAMAS|EXTRA|PREMIUM|INTEIRO|PORCIONADO|CORTADO|COZIDO)\b/g, ' ');
      n = n.replace(/\s+/g, ' ').trim();
      
      // Regras de Ouro (Força a barra para os itens mais críticos)
      if (n.includes('FILE MIGNON') || n.includes('MIGNON')) return 'FILE MIGNON';
      if (n.includes('SALMAO')) return 'FILE DE SALMAO';
      if (n.includes('POLPETONE')) return 'POLPETONE';
      if (n.includes('BATATA') && (n.includes('FRITA') || n.includes('9MM') || n.includes('MCCAIN'))) return 'BATATA FRITA';

      return n;
    };

    const estoqueMap = new Map<string, any>();

    // 1. Processa Inventário (A Base)
    (inventarios || []).forEach(i => {
      const norm = normalizarNome(i.produto);
      if (!estoqueMap.has(norm)) {
        estoqueMap.set(norm, { produto: norm, nomes_originais: new Set([i.produto]), data_base: i.data_contagem, saldo_base: Number(i.quantidade), entradas: 0, saidas: 0 });
      } else {
        const item = estoqueMap.get(norm);
        item.nomes_originais.add(i.produto);
        // Mantém apenas a contagem mais recente
        if (i.data_contagem > item.data_base) {
           item.data_base = i.data_contagem;
           item.saldo_base = Number(i.quantidade);
        }
      }
    });

    // 2. Processa Compras (Soma o que entrou DEPOIS da contagem)
    (compras || []).forEach(c => {
      const norm = normalizarNome(c.produto);
      if (!estoqueMap.has(norm)) {
        estoqueMap.set(norm, { produto: norm, nomes_originais: new Set([c.produto]), data_base: '2000-01-01', saldo_base: 0, entradas: 0, saidas: 0 });
      }
      const item = estoqueMap.get(norm);
      item.nomes_originais.add(c.produto);
      
      if (c.data_compra > item.data_base) {
        item.entradas += Number(c.quantidade);
      }
    });

    // 3. Processa Consumo (Subtrai o que foi vendido DEPOIS da contagem)
    (consumos || []).forEach(c => {
      const norm = normalizarNome(c.ingredient);
      const dataVenda = weekDates[c.week_id];
      if (!estoqueMap.has(norm)) {
        estoqueMap.set(norm, { produto: norm, nomes_originais: new Set([c.ingredient]), data_base: '2000-01-01', saldo_base: 0, entradas: 0, saidas: 0 });
      }
      const item = estoqueMap.get(norm);
      item.nomes_originais.add(c.ingredient);
      
      if (dataVenda > item.data_base) {
        item.saidas += Number(c.kg);
      }
    });

    // 4. Calcula o Resultado Final
    const estoqueCalculado = Array.from(estoqueMap.values()).map(item => {
      item.saldo_atual = item.saldo_base + item.entradas - item.saidas;
      item.nomes_originais = Array.from(item.nomes_originais).join(' | ');
      item.data_base = item.data_base === '2000-01-01' ? null : item.data_base;
      return item;
    });

    estoqueCalculado.sort((a, b) => a.produto.localeCompare(b.produto));
    res.json(estoqueCalculado);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🍽  Controle de Matéria-Prima rodando na porta ${PORT}`);
});