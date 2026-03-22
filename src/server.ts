/**
 * controle-materia-prima — Backend (Express + TypeScript + Supabase)
 *
 * ============================================================
 *  SETUP INSTRUCTIONS
 * ============================================================
 *
 * 1. CREATE FREE SUPABASE PROJECT
 *    → https://app.supabase.com  → New project
 *
 * 2. CREATE TABLES — paste this SQL in the Supabase SQL Editor:
 *
 *    -- Enable UUID extension (usually already on)
 *    create extension if not exists "uuid-ossp";
 *
 *    create table if not exists recipes (
 *      id           uuid primary key default uuid_generate_v4(),
 *      name         text unique not null,
 *      created_at   timestamptz default now()
 *    );
 *
 *    create table if not exists recipe_ingredients (
 *      id                uuid primary key default uuid_generate_v4(),
 *      recipe_id         uuid references recipes(id) on delete cascade,
 *      ingredient        text not null,
 *      grams_per_portion integer not null,
 *      created_at        timestamptz default now()
 *    );
 *
 *    create table if not exists weeks (
 *      id             uuid primary key default uuid_generate_v4(),
 *      week_code      text unique not null,
 *      total_portions integer not null default 0,
 *      created_at     timestamptz default now()
 *    );
 *
 *    create table if not exists consumption_records (
 *      id          uuid primary key default uuid_generate_v4(),
 *      week_id     uuid references weeks(id) on delete cascade,
 *      ingredient  text not null,
 *      kg          numeric not null,
 *      created_at  timestamptz default now()
 *    );
 *
 *    -- RLS: disable for service_role (backend-only tool, no public access)
 *    alter table recipes              enable row level security;
 *    alter table recipe_ingredients   enable row level security;
 *    alter table weeks                enable row level security;
 *    alter table consumption_records  enable row level security;
 *
 *    -- Allow all via service_role key (used only in backend)
 *    create policy "service_role full access recipes"
 *      on recipes for all using (true) with check (true);
 *    create policy "service_role full access recipe_ingredients"
 *      on recipe_ingredients for all using (true) with check (true);
 *    create policy "service_role full access weeks"
 *      on weeks for all using (true) with check (true);
 *    create policy "service_role full access consumption_records"
 *      on consumption_records for all using (true) with check (true);
 *
 * 3. GET KEYS
 *    → Supabase Dashboard → Settings → API
 *    → Copy "Project URL" and "service_role" secret key
 *
 * 4. CREATE .env FILE in project root:
 *    SUPABASE_URL=https://your-project-ref.supabase.co
 *    SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
 *    PORT=3000
 *
 * 5. INSTALL & RUN:
 *    npm install
 *    npm run dev
 *    → open http://localhost:3000
 *
 * ============================================================
 */

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
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Multer (temp disk storage in /uploads) ───────────────────
const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos .csv são aceitos'));
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
 *  Week 1 = the week containing Jan 1 that starts on Sunday.
 *  Returns "YYYY-Www" e.g. "2026-W12"
 */
function sundayWeekCode(d: Date): string {
  // Clone and set to Sunday of this week
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - d.getDay()); // d.getDay(): 0=Sun,1=Mon,...,6=Sat
  sunday.setHours(0, 0, 0, 0);

  // Week number = floor((dayOfYear of sunday) / 7) + 1
  const jan1 = new Date(sunday.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((sunday.getTime() - jan1.getTime()) / 864e5);
  const weekNum = Math.floor(dayOfYear / 7) + 1;
  const year = sunday.getFullYear();
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

/** Convert dd/mm/yyyy string → week code "YYYY-Www" (Sunday–Saturday) */
function toWeekCode(dateStr: string): string | null {
  const d = parseDate(dateStr.trim(), 'dd/MM/yyyy', new Date());
  if (!isValid(d)) return null;
  return sundayWeekCode(d);
}

/** Format week code for display: "2024-W05" → "Semana 5 de 2024" */
// Used only by frontend but defined here for consistency

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

      // Detect if first row is a header (non-numeric third column)
      let dataRows = rows;
      const firstDataRow = rows[0];
      if (firstDataRow && isNaN(Number(firstDataRow[2]))) {
        dataRows = rows.slice(1); // skip header
      }

      // Group by dish name
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
        // Upsert recipe
        const { data: recipe, error: recipeErr } = await supabase
          .from('recipes')
          .upsert({ name: dishName }, { onConflict: 'name' })
          .select('id')
          .single();

        if (recipeErr || !recipe) {
          throw new Error(`Erro ao salvar prato "${dishName}": ${recipeErr?.message}`);
        }

        // Delete old ingredients for this recipe
        await supabase
          .from('recipe_ingredients')
          .delete()
          .eq('recipe_id', recipe.id);

        // Insert new ingredients
        const ingredientRows = ingredients.map(i => ({
          recipe_id: recipe.id,
          ingredient: i.ingredient,
          grams_per_portion: i.grams,
        }));

        const { error: ingErr } = await supabase
          .from('recipe_ingredients')
          .insert(ingredientRows);

        if (ingErr) {
          throw new Error(`Erro ao salvar ingredientes de "${dishName}": ${ingErr.message}`);
        }

        upsertedDishes++;
        totalIngredients += ingredients.length;
      }

      // Log the upload
      try {
        await supabase.from('upload_logs').insert({
          type: 'fichas',
          filename: req.file.originalname,
          week_code: null,
          result: `${upsertedDishes} prato(s), ${totalIngredients} ingrediente(s)`,
        });
      } catch { /* log não-bloqueante */ }

      res.json({
        success: true,
        message: `✅ ${upsertedDishes} prato(s) e ${totalIngredients} ingrediente(s) salvos com sucesso!`,
        dishes: upsertedDishes,
        ingredients: totalIngredients,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido';
      res.status(500).json({ error: `Erro ao processar fichas técnicas: ${message}` });
    } finally {
      cleanFile(filepath);
    }
  }
);

// ── Route: POST /api/weeks/upload ────────────────────────────
// Accepts the PDV report format directly — no editing needed:
//   categoria;grupo;codigo;descricao;qtd;vl_tot
// The week is determined by the upload date (?weekCode=YYYY-Www query param,
// or auto-calculated from today if omitted).
// Only rows whose "descricao" exactly matches a registered recipe are processed.
// Everything else (drinks, desserts, entries, etc.) is silently skipped.
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
      // Check if recipes exist
      const { count: recipeCount } = await supabase
        .from('recipes')
        .select('id', { count: 'exact', head: true });

      if (!recipeCount || recipeCount === 0) {
        res.status(400).json({
          error: '⚠️ Nenhuma ficha técnica encontrada! Suba as fichas técnicas primeiro.',
        });
        return;
      }

      // Read file — detect and handle multiple encodings:
      // UTF-16 LE (BOM FF FE), UTF-16 BE (BOM FE FF), UTF-8 BOM (EF BB BF), latin1
      const rawBuf = fs.readFileSync(filepath);

      let textUtf8: string;
      const b0 = rawBuf[0], b1 = rawBuf[1], b2 = rawBuf[2];

      if (b0 === 0xFF && b1 === 0xFE) {
        // UTF-16 LE with BOM (common in Windows PDV exports)
        textUtf8 = rawBuf.slice(2).toString('utf16le');
      } else if (b0 === 0xFE && b1 === 0xFF) {
        // UTF-16 BE with BOM
        const swapped = Buffer.alloc(rawBuf.length - 2);
        for (let i = 0; i < swapped.length; i += 2) {
          swapped[i]     = rawBuf[i + 3];
          swapped[i + 1] = rawBuf[i + 2];
        }
        textUtf8 = swapped.toString('utf16le');
      } else if (b0 === 0xEF && b1 === 0xBB && b2 === 0xBF) {
        // UTF-8 with BOM — strip BOM
        textUtf8 = rawBuf.slice(3).toString('utf8');
      } else {
        // Try UTF-8, fall back to latin1
        const asUtf8 = rawBuf.toString('utf8');
        textUtf8 = asUtf8.includes('\uFFFD')
          ? Buffer.from(rawBuf.toString('latin1'), 'latin1').toString('utf8')
          : asUtf8;
      }

      // Strip any remaining null bytes and normalize line endings
      textUtf8 = textUtf8.replace(/\u0000/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

      const firstLine = textUtf8.split('\n')[0] ?? '';
      const delimiter = detectDelimiter(firstLine);
      const rows = await parseCsvBuffer(Buffer.from(textUtf8), delimiter);

      if (rows.length === 0) {
        res.status(400).json({ error: 'Arquivo CSV vazio.' });
        return;
      }

      // ── Detect PDV column positions from header row ───────────
      // Header: categoria;grupo;codigo;descricao;qtd;vl_tot
      const headerRow = rows[0].map(h => h.toLowerCase().trim().replace(/[^a-z_]/g, ''));
      const colDescricao = headerRow.indexOf('descricao');
      const colQtd       = headerRow.findIndex(h => h === 'qtd');
      const isPdvFormat  = colDescricao >= 0 && colQtd >= 0;

      // Fallback: old format Data;Prato;Quantidade (columns 0,1,2)
      const useColDesc = isPdvFormat ? colDescricao : 1;
      const useColQtd  = isPdvFormat ? colQtd       : 2;
      const dataRows   = rows.slice(1); // always skip header

      // ── Determine week code ───────────────────────────────────
      // Frontend sends ?weekCode=YYYY-Www, otherwise we use the current ISO week
      const weekCode: string =
        (typeof req.query.weekCode === 'string' && req.query.weekCode.match(/^\d{4}-W\d{2}$/))
          ? req.query.weekCode
          : getISOWeekToday();

      // ── Load all recipes into memory ──────────────────────────
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

      // ── Process rows ──────────────────────────────────────────
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

        if (!recipe) {
          // No recipe → silently skip (drinks, desserts, entries, etc.)
          skippedCount++;
          continue;
        }

        totalPortions += qty;
        matchedDishes.add(dishName);

        for (const ing of recipe) {
          ingredientTotals[ing.ingredient] = (ingredientTotals[ing.ingredient] ?? 0) + (ing.grams * qty);
        }
      }

      if (Object.keys(ingredientTotals).length === 0) {
        res.status(400).json({
          error: '⚠️ Nenhum prato com ficha técnica encontrado no arquivo. Verifique se as fichas técnicas estão cadastradas com os mesmos nomes do PDV.',
        });
        return;
      }

      // ── Upsert week + consumption records ─────────────────────
      const { data: weekRow, error: weekErr } = await supabase
        .from('weeks')
        .upsert(
          { week_code: weekCode, total_portions: totalPortions },
          { onConflict: 'week_code' }
        )
        .select('id')
        .single();

      if (weekErr || !weekRow) {
        throw new Error(`Erro ao salvar semana "${weekCode}": ${weekErr?.message}`);
      }

      // Replace all records for this week
      await supabase.from('consumption_records').delete().eq('week_id', weekRow.id);

      const records = Object.entries(ingredientTotals).map(([ingredient, grams]) => ({
        week_id: weekRow.id,
        ingredient,
        kg: parseFloat((grams / 1000).toFixed(4)),
      }));

      const { error: recErr } = await supabase.from('consumption_records').insert(records);
      if (recErr) throw new Error(`Erro ao salvar consumo: ${recErr.message}`);

      // Log the upload
      try {
        await supabase.from('upload_logs').insert({
          type: 'saidas',
          filename: req.file.originalname,
          week_code: weekCode,
          result: `${matchedDishes.size} pratos · ${totalPortions} porções · ${skippedCount} ignorados`,
        });
      } catch { /* log não-bloqueante */ }

      res.json({
        success: true,
        message: `✅ Semana ${weekCode} salva! ${matchedDishes.size} prato(s) processado(s) · ${totalPortions} porções · ${skippedCount} item(ns) sem ficha ignorado(s).`,
        week: weekCode,
        matched_dishes: matchedDishes.size,
        total_portions: totalPortions,
        skipped_count: skippedCount,
      });

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido';
      res.status(500).json({ error: `Erro ao processar saídas: ${message}` });
    } finally {
      cleanFile(filepath);
    }
  }
);

// Returns current ISO week string "YYYY-Www"
function getISOWeekToday(): string {
  return sundayWeekCode(new Date());
}

// ── Route: GET /api/weeks ────────────────────────────────────
app.get('/api/weeks', async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data: weeks, error: weeksErr } = await supabase
      .from('weeks')
      .select('id, week_code, total_portions, created_at')
      .order('week_code', { ascending: false });

    if (weeksErr) throw new Error(weeksErr.message);

    // Get total kg per week via consumption_records
    const weekIds = (weeks ?? []).map(w => w.id);
    let kgByWeek: Record<string, number> = {};

    if (weekIds.length > 0) {
      const { data: records, error: recErr } = await supabase
        .from('consumption_records')
        .select('week_id, kg')
        .in('week_id', weekIds);

      if (recErr) throw new Error(recErr.message);

      for (const r of records ?? []) {
        kgByWeek[r.week_id] = (kgByWeek[r.week_id] ?? 0) + Number(r.kg);
      }
    }

    const result = (weeks ?? []).map(w => ({
      id: w.id,
      week_code: w.week_code,
      total_portions: w.total_portions,
      total_kg: parseFloat((kgByWeek[w.id] ?? 0).toFixed(3)),
      created_at: w.created_at,
    }));

    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    res.status(500).json({ error: message });
  }
});

// ── Route: GET /api/weeks/:weekCode ─────────────────────────
app.get('/api/weeks/:weekCode', async (req: Request, res: Response): Promise<void> => {
  const { weekCode } = req.params;

  try {
    const { data: week, error: weekErr } = await supabase
      .from('weeks')
      .select('id, week_code, total_portions')
      .eq('week_code', weekCode)
      .single();

    if (weekErr || !week) {
      res.status(404).json({ error: `Semana "${weekCode}" não encontrada.` });
      return;
    }

    const { data: records, error: recErr } = await supabase
      .from('consumption_records')
      .select('ingredient, kg')
      .eq('week_id', week.id)
      .order('kg', { ascending: false });

    if (recErr) throw new Error(recErr.message);

    const totalKg = (records ?? []).reduce((sum, r) => sum + Number(r.kg), 0);

    res.json({
      week_code: week.week_code,
      total_portions: week.total_portions,
      total_kg: parseFloat(totalKg.toFixed(3)),
      records: (records ?? []).map(r => ({
        ingredient: r.ingredient,
        kg: parseFloat(Number(r.kg).toFixed(3)),
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    res.status(500).json({ error: message });
  }
});

// ── Route: GET /api/recipes ──────────────────────────────────
app.get('/api/recipes', async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('recipes')
      .select('id, name, created_at')
      .order('name');

    if (error) throw new Error(error.message);
    res.json(data ?? []);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    res.status(500).json({ error: message });
  }
});

// ── Route: GET /api/recipes/list — flat rows for table display ──
app.get('/api/recipes/list', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Join recipe_ingredients with recipes using Supabase embedded select
    const { data, error } = await supabase
      .from('recipe_ingredients')
      .select('ingredient, grams_per_portion, recipes(name)')
      .order('ingredient');

    if (error) throw new Error(error.message);

    // Flatten and sort by dish name then ingredient
    const flat = (data ?? [])
      .map(r => {
        const recipesField = r.recipes as unknown as { name: string } | { name: string }[] | null;
        if (!recipesField) return null;
        const dishName = Array.isArray(recipesField) ? recipesField[0]?.name : recipesField.name;
        if (!dishName) return null;
        return {
          dish: dishName,
          ingredient: String(r.ingredient),
          grams_per_portion: Number(r.grams_per_portion),
        };
      })
      .filter((r): r is { dish: string; ingredient: string; grams_per_portion: number } => r !== null)
      .sort((a, b) => { const d = a.dish.localeCompare(b.dish); return d !== 0 ? d : a.ingredient.localeCompare(b.ingredient); });

    res.json(flat);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    res.status(500).json({ error: message });
  }
});

// ── Route: DELETE /api/all — clear all data ──────────────────
app.delete('/api/all', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Deleting weeks cascades to consumption_records
    // Deleting recipes cascades to recipe_ingredients
    await supabase.from('consumption_records').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('weeks').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('recipe_ingredients').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('recipes').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    res.json({ success: true, message: 'Todos os dados foram apagados.' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    res.status(500).json({ error: message });
  }
});

// ── Dashboard summary endpoint ───────────────────────────────
app.get('/api/dashboard', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Current month ISO weeks: get all weeks for this year-month
    const now = new Date();
    const yearPrefix = `${now.getFullYear()}-W`;

    const { data: allWeeks } = await supabase
      .from('weeks')
      .select('id, week_code, total_portions')
      .order('week_code', { ascending: false });

    const { data: allRecords } = await supabase
      .from('consumption_records')
      .select('week_id, ingredient, kg');

    const weeksArr = allWeeks ?? [];
    const recordsArr = allRecords ?? [];

    // Map weekId → week_code
    const weekIdToCode = new Map(weeksArr.map(w => [w.id, w.week_code]));

    // This year's data (approximate "this year" for monthly filter)
    const thisYearWeeks = weeksArr.filter(w => w.week_code.startsWith(yearPrefix));
    const thisYearWeekIds = new Set(thisYearWeeks.map(w => w.id));

    const monthRecords = recordsArr.filter(r => thisYearWeekIds.has(r.week_id));

    const totalKgThisYear = monthRecords.reduce((s, r) => s + Number(r.kg), 0);
    const totalPortionsThisYear = thisYearWeeks.reduce((s, w) => s + w.total_portions, 0);

    // Top 5 ingredients this year
    const ingMap: Record<string, number> = {};
    for (const r of monthRecords) {
      ingMap[r.ingredient] = (ingMap[r.ingredient] ?? 0) + Number(r.kg);
    }
    const top5 = Object.entries(ingMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ingredient, kg]) => ({ ingredient, kg: parseFloat(kg.toFixed(3)) }));

    // Recipe count
    const { count: recipeCount } = await supabase
      .from('recipes')
      .select('id', { count: 'exact', head: true });

    res.json({
      total_kg_this_year: parseFloat(totalKgThisYear.toFixed(3)),
      total_portions_this_year: totalPortionsThisYear,
      total_weeks: weeksArr.length,
      recipe_count: recipeCount ?? 0,
      top5_ingredients: top5,
      recent_weeks: weeksArr.slice(0, 4).map(w => {
        const weekRecords = recordsArr.filter(r => r.week_id === w.id);
        const kg = weekRecords.reduce((s, r) => s + Number(r.kg), 0);
        return {
          week_code: w.week_code,
          total_portions: w.total_portions,
          total_kg: parseFloat(kg.toFixed(3)),
        };
      }),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    res.status(500).json({ error: message });
  }
});

// ── Route: GET /api/upload-logs ─────────────────────────────────────
app.get('/api/upload-logs', async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('upload_logs')
      .select('id, type, filename, week_code, result, created_at')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw new Error(error.message);
    res.json(data ?? []);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    res.status(500).json({ error: message });
  }
});

// ── Error middleware ─────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message ?? 'Erro interno do servidor' });
});

// ── Start server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🍽  Controle de Matéria-Prima rodando em http://localhost:${PORT}`);
  console.log(`   Supabase: ${SUPABASE_URL}`);
  console.log(`   Pressione Ctrl+C para parar\n`);
});
