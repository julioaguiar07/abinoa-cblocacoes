const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

app.use(express.json());
app.use(express.static('public'));

// Health check
app.get('/health', async (req, res) => {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.json({ status: 'ok', database: 'disconnected' });
  }
});

// Debug
app.get('/api/debug', async (req, res) => {
  try {
    const client = await pool.connect();
    const tables = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const categorias = await client.query('SELECT * FROM categorias');
    client.release();
    res.json({ connected: true, tables: tables.rows, categorias: categorias.rows });
  } catch (error) {
    res.json({ connected: false, error: error.message });
  }
});

// ===== INICIALIZAÇÃO DO BANCO =====
async function initDatabase() {
  const client = await pool.connect();
  try {
    console.log('📦 Criando tabelas...');
    
    await client.query(`
      -- Categorias
      CREATE TABLE IF NOT EXISTS categorias (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL UNIQUE,
        icone VARCHAR(10) DEFAULT '🚧',
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Máquinas
      CREATE TABLE IF NOT EXISTS maquinas (
        id SERIAL PRIMARY KEY,
        categoria_id INTEGER REFERENCES categorias(id),
        nome VARCHAR(200) NOT NULL,
        numero_serie VARCHAR(100),
        placa VARCHAR(20),
        local_compra VARCHAR(200),
        numero_nota VARCHAR(100),
        valor_compra DECIMAL(12,2) DEFAULT 0,
        valor_locacao DECIMAL(10,2) DEFAULT 0,
        combustivel VARCHAR(50),
        status_financeiro VARCHAR(50) DEFAULT 'pendente',
        status VARCHAR(50) DEFAULT 'disponivel',
        tem_operador BOOLEAN DEFAULT false,
        observacao TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Obras
      CREATE TABLE IF NOT EXISTS obras (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(200) NOT NULL,
        local VARCHAR(300),
        ativa BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Operadores
      CREATE TABLE IF NOT EXISTS operadores (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(200) NOT NULL,
        telefone VARCHAR(50),
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Alocações
      CREATE TABLE IF NOT EXISTS alocacoes (
        id SERIAL PRIMARY KEY,
        maquina_id INTEGER REFERENCES maquinas(id),
        obra_id INTEGER REFERENCES obras(id),
        operador_id INTEGER REFERENCES operadores(id),
        data_inicio DATE DEFAULT CURRENT_DATE,
        data_fim DATE,
        valor_diaria DECIMAL(10,2) DEFAULT 0,
        observacao TEXT,
        ativa BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Problemas
      CREATE TABLE IF NOT EXISTS problemas (
        id SERIAL PRIMARY KEY,
        maquina_id INTEGER REFERENCES maquinas(id),
        descricao TEXT NOT NULL,
        tipo VARCHAR(50),
        prioridade VARCHAR(20) DEFAULT 'media',
        status VARCHAR(20) DEFAULT 'pendente',
        reportado_por VARCHAR(200),
        custo_reparo DECIMAL(10,2) DEFAULT 0,
        observacao_resolucao TEXT,
        resolvido_em TIMESTAMP,
        criado_em TIMESTAMP DEFAULT NOW()
      );

      -- Gastos da máquina
      CREATE TABLE IF NOT EXISTS gastos (
        id SERIAL PRIMARY KEY,
        maquina_id INTEGER REFERENCES maquinas(id),
        descricao VARCHAR(300) NOT NULL,
        valor DECIMAL(10,2) NOT NULL,
        tipo VARCHAR(50) DEFAULT 'outro',
        data DATE DEFAULT CURRENT_DATE,
        observacao TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Pagamentos da máquina
      CREATE TABLE IF NOT EXISTS pagamentos (
        id SERIAL PRIMARY KEY,
        maquina_id INTEGER REFERENCES maquinas(id),
        valor DECIMAL(10,2) NOT NULL,
        data DATE DEFAULT CURRENT_DATE,
        observacao TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('✅ Tabelas criadas!');

    // CORREÇÃO: Inserir categorias uma por uma
    const categorias = [
      { nome: 'Minicarregadeira', icone: '🏗️' },
      { nome: 'Miniescavadeira', icone: '⛏️' },
      { nome: 'Mini Retro', icone: '🚜' },
      { nome: 'Retroescavadeira', icone: '🏗️' },
      { nome: 'Manipulador', icone: '🦾' },
      { nome: 'Caminhão', icone: '🚛' },
      { nome: 'Outros', icone: '🔧' }
    ];

    for (const cat of categorias) {
      await client.query(`
        INSERT INTO categorias (nome, icone) 
        VALUES ($1, $2) 
        ON CONFLICT (nome) DO NOTHING
      `, [cat.nome, cat.icone]);
    }

    // Verificar se inseriu
    const cats = await client.query('SELECT COUNT(*) FROM categorias');
    console.log(`✅ ${cats.rows[0].count} categorias inseridas`);
    console.log('✅ Banco de dados inicializado com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro ao inicializar banco:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

// ===== ROTAS DA API =====

// Dashboard
app.get('/api/dashboard', async (req, res) => {
  try {
    const [stats, categorias, problemasPendentes, alocacoesAtivas, gastosMes, faturamentoMes, maquinasPagas] = await Promise.all([
      pool.query(`
        SELECT 
          COUNT(*)::integer as total_maquinas,
          COUNT(CASE WHEN status = 'locado' THEN 1 END)::integer as locadas,
          COUNT(CASE WHEN status = 'disponivel' THEN 1 END)::integer as disponiveis,
          COUNT(CASE WHEN status = 'manutencao' THEN 1 END)::integer as em_manutencao,
          COUNT(CASE WHEN status = 'inativo' THEN 1 END)::integer as inativas,
          COALESCE(SUM(valor_compra), 0)::float as investimento_total,
          COALESCE(SUM(valor_locacao), 0)::float as receita_potencial
        FROM maquinas
      `),
      pool.query(`
        SELECT 
          c.id, c.nome, c.icone,
          COUNT(m.id)::integer as total,
          COUNT(CASE WHEN m.status = 'locado' THEN 1 END)::integer as locadas,
          COUNT(CASE WHEN m.status = 'disponivel' THEN 1 END)::integer as disponiveis,
          COUNT(CASE WHEN m.status = 'manutencao' THEN 1 END)::integer as manutencao,
          COALESCE(SUM(m.valor_compra), 0)::float as investimento,
          COALESCE(SUM(m.valor_locacao) FILTER (WHERE m.status = 'locado'), 0)::float as receita_ativa
        FROM categorias c
        LEFT JOIN maquinas m ON c.id = m.categoria_id
        GROUP BY c.id, c.nome, c.icone
        HAVING COUNT(m.id) > 0
        ORDER BY total DESC
      `),
      pool.query(`
        SELECT p.*, m.nome as maquina_nome, c.icone
        FROM problemas p
        JOIN maquinas m ON p.maquina_id = m.id
        LEFT JOIN categorias c ON m.categoria_id = c.id
        WHERE p.status = 'pendente'
        ORDER BY CASE p.prioridade 
          WHEN 'critica' THEN 1 WHEN 'alta' THEN 2 
          WHEN 'media' THEN 3 WHEN 'baixa' THEN 4 
        END, p.criado_em DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT a.*, m.nome as maquina_nome, c.icone,
               o.nome as obra_nome, op.nome as operador_nome
        FROM alocacoes a
        JOIN maquinas m ON a.maquina_id = m.id
        LEFT JOIN categorias c ON m.categoria_id = c.id
        LEFT JOIN obras o ON a.obra_id = o.id
        LEFT JOIN operadores op ON a.operador_id = op.id
        WHERE a.ativa = true
        ORDER BY a.data_inicio DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT COALESCE(SUM(valor), 0)::float as total
        FROM gastos 
        WHERE EXTRACT(MONTH FROM data) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(YEAR FROM data) = EXTRACT(YEAR FROM CURRENT_DATE)
      `),
      pool.query(`
        SELECT 
          COALESCE(SUM(a.valor_diaria * (COALESCE(a.data_fim, CURRENT_DATE) - a.data_inicio + 1)), 0)::float as total
        FROM alocacoes a
        WHERE EXTRACT(MONTH FROM COALESCE(a.data_fim, CURRENT_DATE)) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(YEAR FROM COALESCE(a.data_fim, CURRENT_DATE)) = EXTRACT(YEAR FROM CURRENT_DATE)
      `),
      pool.query(`
        SELECT COUNT(*)::integer as total
        FROM maquinas
        WHERE status_financeiro = 'quitado'
      `)
    ]);

    res.json({
      totais: stats.rows[0],
      porCategoria: categorias.rows,
      problemasPendentes: problemasPendentes.rows,
      alocacoesAtivas: alocacoesAtivas.rows,
      gastos_mes: gastosMes.rows[0].total,
      faturamento_mes: faturamentoMes.rows[0].total,
      maquinas_pagas: maquinasPagas.rows[0].total
    });
  } catch (error) {
    console.error('Erro dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dados para gráficos temporais
app.get('/api/graficos', async (req, res) => {
  try {
    const [faturamentoMensal, gastosMensal, alocacoesPorObra] = await Promise.all([
      pool.query(`
        SELECT 
          TO_CHAR(DATE_TRUNC('month', COALESCE(data_fim, CURRENT_DATE)), 'YYYY-MM') as mes,
          COALESCE(SUM(valor_diaria * (COALESCE(data_fim, CURRENT_DATE) - data_inicio + 1)), 0)::float as faturamento
        FROM alocacoes
        WHERE data_inicio >= CURRENT_DATE - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', COALESCE(data_fim, CURRENT_DATE))
        ORDER BY mes
      `),
      pool.query(`
        SELECT 
          TO_CHAR(DATE_TRUNC('month', data), 'YYYY-MM') as mes,
          COALESCE(SUM(valor), 0)::float as total_gastos
        FROM gastos
        WHERE data >= CURRENT_DATE - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', data)
        ORDER BY mes
      `),
      pool.query(`
        SELECT 
          o.nome as obra,
          COUNT(a.id)::integer as total_alocacoes
        FROM alocacoes a
        JOIN obras o ON a.obra_id = o.id
        WHERE a.data_inicio >= CURRENT_DATE - INTERVAL '6 months'
        GROUP BY o.nome
        ORDER BY total_alocacoes DESC
        LIMIT 10
      `)
    ]);

    res.json({
      faturamentoMensal: faturamentoMensal.rows,
      gastosMensal: gastosMensal.rows,
      alocacoesPorObra: alocacoesPorObra.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Categorias (CORRIGIDO - sempre retorna)
app.get('/api/categorias', async (req, res) => {
  try {
    // Primeiro verifica se tem categorias
    let result = await pool.query(`
      SELECT c.*, COUNT(m.id)::integer as total_maquinas
      FROM categorias c
      LEFT JOIN maquinas m ON c.id = m.categoria_id
      GROUP BY c.id
      ORDER BY c.nome
    `);

    // Se não tiver categorias, insere as padrão
    if (result.rows.length === 0) {
      const categorias = [
        ['Minicarregadeira', '🏗️'],
        ['Miniescavadeira', '⛏️'],
        ['Mini Retro', '🚜'],
        ['Retroescavadeira', '🏗️'],
        ['Manipulador', '🦾'],
        ['Caminhão', '🚛'],
        ['Outros', '🔧']
      ];

      for (const [nome, icone] of categorias) {
        await pool.query(
          'INSERT INTO categorias (nome, icone) VALUES ($1, $2) ON CONFLICT (nome) DO NOTHING',
          [nome, icone]
        );
      }

      result = await pool.query(`
        SELECT c.*, COUNT(m.id)::integer as total_maquinas
        FROM categorias c
        LEFT JOIN maquinas m ON c.id = m.categoria_id
        GROUP BY c.id
        ORDER BY c.nome
      `);
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Erro categorias:', error);
    res.status(500).json({ error: error.message });
  }
});

// Máquinas - GET com todos os dados financeiros
app.get('/api/maquinas', async (req, res) => {
  try {
    const { categoria, status, search } = req.query;
    let query = `
      SELECT 
        m.*,
        c.nome as categoria_nome,
        c.icone as categoria_icone,
        o.nome as obra_nome,
        op.nome as operador_nome,
        (SELECT COUNT(*)::integer FROM problemas WHERE maquina_id = m.id AND status = 'pendente') as problemas_pendentes,
        (SELECT COALESCE(SUM(valor), 0)::float FROM gastos WHERE maquina_id = m.id) as total_gastos,
        (SELECT COALESCE(SUM(valor), 0)::float FROM pagamentos WHERE maquina_id = m.id) as total_pago,
        (m.valor_compra - COALESCE((SELECT SUM(valor) FROM pagamentos WHERE maquina_id = m.id), 0))::float as saldo_devedor
      FROM maquinas m
      LEFT JOIN categorias c ON m.categoria_id = c.id
      LEFT JOIN alocacoes a ON m.id = a.maquina_id AND a.ativa = true
      LEFT JOIN obras o ON a.obra_id = o.id
      LEFT JOIN operadores op ON a.operador_id = op.id
      WHERE 1=1
    `;
    const params = [];

    if (categoria) { params.push(categoria); query += ` AND m.categoria_id = $${params.length}`; }
    if (status) { params.push(status); query += ` AND m.status = $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (m.nome ILIKE $${params.length} OR m.numero_serie ILIKE $${params.length} OR m.placa ILIKE $${params.length})`; }

    query += ` ORDER BY m.nome`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Erro máquinas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Máquina específica com dados completos
app.get('/api/maquinas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [maquina, alocacoes, problemas, gastos, pagamentos] = await Promise.all([
      pool.query(`
        SELECT m.*, c.nome as categoria_nome, c.icone as categoria_icone,
          (SELECT COALESCE(SUM(valor), 0) FROM gastos WHERE maquina_id = m.id) as total_gastos,
          (SELECT COALESCE(SUM(valor), 0) FROM pagamentos WHERE maquina_id = m.id) as total_pago
        FROM maquinas m 
        LEFT JOIN categorias c ON m.categoria_id = c.id
        WHERE m.id = $1
      `, [id]),
      pool.query(`
        SELECT a.*, o.nome as obra_nome, op.nome as operador_nome,
          (a.valor_diaria * (COALESCE(a.data_fim, CURRENT_DATE) - a.data_inicio + 1)) as valor_total
        FROM alocacoes a 
        LEFT JOIN obras o ON a.obra_id = o.id 
        LEFT JOIN operadores op ON a.operador_id = op.id 
        WHERE a.maquina_id = $1 
        ORDER BY a.data_inicio DESC
      `, [id]),
      pool.query('SELECT * FROM problemas WHERE maquina_id = $1 ORDER BY criado_em DESC', [id]),
      pool.query('SELECT * FROM gastos WHERE maquina_id = $1 ORDER BY data DESC', [id]),
      pool.query('SELECT * FROM pagamentos WHERE maquina_id = $1 ORDER BY data DESC', [id])
    ]);

    if (maquina.rows.length === 0) {
      return res.status(404).json({ error: 'Máquina não encontrada' });
    }

    res.json({
      maquina: maquina.rows[0],
      alocacoes: alocacoes.rows,
      problemas: problemas.rows,
      gastos: gastos.rows,
      pagamentos: pagamentos.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Criar máquina
app.post('/api/maquinas', async (req, res) => {
  try {
    const { 
      categoria_id, nome, numero_serie, placa, local_compra,
      numero_nota, valor_compra, valor_locacao, combustivel, 
      status_financeiro, status, tem_operador, observacao
    } = req.body;

    const result = await pool.query(`
      INSERT INTO maquinas (
        categoria_id, nome, numero_serie, placa, local_compra,
        numero_nota, valor_compra, valor_locacao, combustivel, 
        status_financeiro, status, tem_operador, observacao
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) 
      RETURNING *
    `, [
      categoria_id, nome, numero_serie, placa, local_compra,
      numero_nota, valor_compra || 0, valor_locacao || 0, combustivel, 
      status_financeiro || 'pendente', status || 'disponivel', 
      tem_operador || false, observacao
    ]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro criar máquina:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar máquina
app.put('/api/maquinas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      categoria_id, nome, numero_serie, placa, local_compra,
      numero_nota, valor_compra, valor_locacao, combustivel, 
      status_financeiro, status, tem_operador, observacao
    } = req.body;

    const result = await pool.query(`
      UPDATE maquinas SET
        categoria_id=$1, nome=$2, numero_serie=$3, placa=$4,
        local_compra=$5, numero_nota=$6, valor_compra=$7, 
        valor_locacao=$8, combustivel=$9, status_financeiro=$10, 
        status=$11, tem_operador=$12, observacao=$13, updated_at=NOW()
      WHERE id=$14 RETURNING *
    `, [
      categoria_id, nome, numero_serie, placa, local_compra,
      numero_nota, valor_compra || 0, valor_locacao || 0, combustivel, 
      status_financeiro || 'pendente', status || 'disponivel', 
      tem_operador || false, observacao, id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Máquina não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Gastos da máquina
app.get('/api/maquinas/:id/gastos', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM gastos WHERE maquina_id = $1 ORDER BY data DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/maquinas/:id/gastos', async (req, res) => {
  try {
    const { descricao, valor, tipo, data, observacao } = req.body;
    const result = await pool.query(
      'INSERT INTO gastos (maquina_id, descricao, valor, tipo, data, observacao) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.id, descricao, valor, tipo || 'outro', data || new Date().toISOString().split('T')[0], observacao]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Pagamentos da máquina
app.get('/api/maquinas/:id/pagamentos', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM pagamentos WHERE maquina_id = $1 ORDER BY data DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/maquinas/:id/pagamentos', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { valor, data, observacao } = req.body;
    const result = await client.query(
      'INSERT INTO pagamentos (maquina_id, valor, data, observacao) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, valor, data || new Date().toISOString().split('T')[0], observacao]
    );

    // Verificar se máquina foi quitada
    const saldo = await client.query(`
      SELECT m.valor_compra - COALESCE(SUM(p.valor), 0) as saldo
      FROM maquinas m
      LEFT JOIN pagamentos p ON m.id = p.maquina_id
      WHERE m.id = $1
      GROUP BY m.id, m.valor_compra
    `, [req.params.id]);

    if (saldo.rows[0] && saldo.rows[0].saldo <= 0) {
      await client.query(
        "UPDATE maquinas SET status_financeiro = 'quitado', updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Obras
app.get('/api/obras', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, 
        (SELECT COUNT(*)::integer FROM alocacoes WHERE obra_id = o.id AND ativa = true) as maquinas_ativas
      FROM obras o ORDER BY o.ativa DESC, o.nome
    `);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/obras', async (req, res) => {
  try {
    const { nome, local } = req.body;
    const result = await pool.query(
      'INSERT INTO obras (nome, local) VALUES ($1, $2) RETURNING *',
      [nome, local]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/obras/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, local, ativa } = req.body;
    const result = await pool.query(
      'UPDATE obras SET nome=$1, local=$2, ativa=$3 WHERE id=$4 RETURNING *',
      [nome, local, ativa, id]
    );
    res.json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/obras/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM obras WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Operadores
app.get('/api/operadores', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, 
        (SELECT COUNT(*)::integer FROM alocacoes WHERE operador_id = o.id AND ativa = true) as alocacoes_ativas
      FROM operadores o WHERE o.ativo = true ORDER BY o.nome
    `);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/operadores', async (req, res) => {
  try {
    const { nome, telefone } = req.body;
    const result = await pool.query(
      'INSERT INTO operadores (nome, telefone) VALUES ($1, $2) RETURNING *',
      [nome, telefone]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/operadores/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, telefone, ativo } = req.body;
    const result = await pool.query(
      'UPDATE operadores SET nome=$1, telefone=$2, ativo=$3 WHERE id=$4 RETURNING *',
      [nome, telefone, ativo, id]
    );
    res.json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/operadores/:id', async (req, res) => {
  try {
    await pool.query('UPDATE operadores SET ativo=false WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Alocações
app.get('/api/alocacoes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        a.*, m.nome as maquina_nome, m.numero_serie, m.placa,
        c.nome as categoria_nome, c.icone,
        o.nome as obra_nome, o.local as obra_local,
        op.nome as operador_nome,
        (a.valor_diaria * (COALESCE(a.data_fim, CURRENT_DATE) - a.data_inicio + 1)) as valor_total
      FROM alocacoes a
      JOIN maquinas m ON a.maquina_id = m.id
      LEFT JOIN categorias c ON m.categoria_id = c.id
      LEFT JOIN obras o ON a.obra_id = o.id
      LEFT JOIN operadores op ON a.operador_id = op.id
      WHERE a.ativa = true
      ORDER BY a.data_inicio DESC
    `);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/alocacoes', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { maquina_id, obra_id, operador_id, data_inicio, valor_diaria, observacao } = req.body;
    
    const result = await client.query(`
      INSERT INTO alocacoes (maquina_id, obra_id, operador_id, data_inicio, valor_diaria, observacao)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [maquina_id, obra_id, operador_id || null, data_inicio || new Date().toISOString().split('T')[0], valor_diaria || 0, observacao]);

    await client.query(
      "UPDATE maquinas SET status='locado', updated_at=NOW() WHERE id=$1",
      [maquina_id]
    );

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally { client.release(); }
});

app.put('/api/alocacoes/:id/encerrar', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const result = await client.query(
      "UPDATE alocacoes SET ativa=false, data_fim=CURRENT_DATE WHERE id=$1 RETURNING *",
      [id]
    );
    if (result.rows.length > 0) {
      await client.query(
        "UPDATE maquinas SET status='disponivel', updated_at=NOW() WHERE id=$1",
        [result.rows[0].maquina_id]
      );
    }
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally { client.release(); }
});

// Problemas
app.get('/api/problemas', async (req, res) => {
  try {
    const { status, prioridade } = req.query;
    let query = `
      SELECT p.*, m.nome as maquina_nome, c.icone 
      FROM problemas p 
      JOIN maquinas m ON p.maquina_id = m.id 
      LEFT JOIN categorias c ON m.categoria_id = c.id 
      WHERE 1=1
    `;
    const params = [];
    if (status) { params.push(status); query += ` AND p.status=$${params.length}`; }
    if (prioridade) { params.push(prioridade); query += ` AND p.prioridade=$${params.length}`; }
    query += ` ORDER BY CASE p.prioridade WHEN 'critica' THEN 1 WHEN 'alta' THEN 2 WHEN 'media' THEN 3 WHEN 'baixa' THEN 4 END, p.criado_em DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/problemas', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { maquina_id, descricao, tipo, prioridade, reportado_por, custo_reparo } = req.body;
    const result = await client.query(
      'INSERT INTO problemas (maquina_id, descricao, tipo, prioridade, reportado_por, custo_reparo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [maquina_id, descricao, tipo, prioridade || 'media', reportado_por, custo_reparo || 0]
    );
    if (prioridade === 'critica') {
      await client.query("UPDATE maquinas SET status='manutencao', updated_at=NOW() WHERE id=$1", [maquina_id]);
    }
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally { client.release(); }
});

app.put('/api/problemas/:id/resolver', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { observacao_resolucao } = req.body;
    const result = await client.query(
      "UPDATE problemas SET status='resolvido', observacao_resolucao=$1, resolvido_em=NOW() WHERE id=$2 RETURNING *",
      [observacao_resolucao || '', id]
    );
    if (result.rows.length > 0) {
      const pendentes = await client.query(
        "SELECT COUNT(*)::integer as count FROM problemas WHERE maquina_id=$1 AND status='pendente'",
        [result.rows[0].maquina_id]
      );
      if (pendentes.rows[0].count === 0) {
        await client.query(
          "UPDATE maquinas SET status='disponivel', updated_at=NOW() WHERE id=$1 AND status='manutencao'",
          [result.rows[0].maquina_id]
        );
      }
    }
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally { client.release(); }
});

app.delete('/api/problemas/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM problemas WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Rota coringa
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
async function startServer() {
  console.log('🚀 Iniciando CB Locações...');
  
  try {
    await initDatabase();
    console.log('✅ Banco de dados pronto!');
  } catch (error) {
    console.error('❌ Erro ao inicializar banco:', error.message);
  }
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
  });
}

startServer().catch(error => {
  console.error('❌ Erro fatal:', error);
  process.exit(1);
});
