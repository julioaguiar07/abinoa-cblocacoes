const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração do PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ===== INICIALIZAÇÃO DO BANCO DE DADOS =====
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Tabela de Categorias
      CREATE TABLE IF NOT EXISTS categorias (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL UNIQUE,
        icone VARCHAR(10) DEFAULT '🚧',
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Tabela de Máquinas
      CREATE TABLE IF NOT EXISTS maquinas (
        id SERIAL PRIMARY KEY,
        categoria_id INTEGER REFERENCES categorias(id),
        nome VARCHAR(200) NOT NULL,
        numero_serie VARCHAR(100),
        placa VARCHAR(20),
        local_compra VARCHAR(200),
        numero_nota VARCHAR(100),
        valor_locacao DECIMAL(10,2),
        combustivel VARCHAR(50),
        status_financeiro VARCHAR(50) DEFAULT 'ok',
        status VARCHAR(50) DEFAULT 'disponivel',
        tem_operador BOOLEAN DEFAULT false,
        observacao TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Tabela de Obras
      CREATE TABLE IF NOT EXISTS obras (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(200) NOT NULL,
        local VARCHAR(300),
        ativa BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Tabela de Operadores
      CREATE TABLE IF NOT EXISTS operadores (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(200) NOT NULL,
        telefone VARCHAR(50),
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Tabela de Alocações
      CREATE TABLE IF NOT EXISTS alocacoes (
        id SERIAL PRIMARY KEY,
        maquina_id INTEGER REFERENCES maquinas(id),
        obra_id INTEGER REFERENCES obras(id),
        operador_id INTEGER REFERENCES operadores(id),
        data_inicio DATE DEFAULT CURRENT_DATE,
        data_fim DATE,
        observacao TEXT,
        ativa BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Tabela de Problemas
      CREATE TABLE IF NOT EXISTS problemas (
        id SERIAL PRIMARY KEY,
        maquina_id INTEGER REFERENCES maquinas(id),
        descricao TEXT NOT NULL,
        tipo VARCHAR(50),
        prioridade VARCHAR(20) DEFAULT 'media',
        status VARCHAR(20) DEFAULT 'pendente',
        reportado_por VARCHAR(200),
        observacao_resolucao TEXT,
        resolvido_em TIMESTAMP,
        criado_em TIMESTAMP DEFAULT NOW()
      );

      -- Inserir categorias padrão
      INSERT INTO categorias (nome, icone) VALUES 
        ('Minicarregadeira', '🏗️'),
        ('Miniescavadeira', '⛏️'),
        ('Mini Retro', '🚜'),
        ('Retroescavadeira', '🏗️'),
        ('Manipulador', '🦾'),
        ('Caminhão', '🚛')
      ON CONFLICT (nome) DO NOTHING;
    `);
    console.log('✅ Banco de dados inicializado com sucesso');
  } catch (error) {
    console.error('❌ Erro ao inicializar banco:', error);
  } finally {
    client.release();
  }
}

// ===== ROTAS DA API =====

// Dashboard
app.get('/api/dashboard', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_maquinas,
        COUNT(CASE WHEN status = 'locado' THEN 1 END) as locadas,
        COUNT(CASE WHEN status = 'disponivel' THEN 1 END) as disponiveis,
        COUNT(CASE WHEN status = 'manutencao' THEN 1 END) as em_manutencao,
        COUNT(CASE WHEN status = 'inativo' THEN 1 END) as inativas
      FROM maquinas
    `);

    const categorias = await pool.query(`
      SELECT 
        c.id,
        c.nome,
        c.icone,
        COUNT(m.id) as total,
        COUNT(CASE WHEN m.status = 'locado' THEN 1 END) as locadas,
        COUNT(CASE WHEN m.status = 'disponivel' THEN 1 END) as disponiveis,
        COUNT(CASE WHEN m.status = 'manutencao' THEN 1 END) as manutencao,
        COALESCE(SUM(m.valor_locacao) FILTER (WHERE m.status = 'locado'), 0) as receita_ativa
      FROM categorias c
      LEFT JOIN maquinas m ON c.id = m.categoria_id
      GROUP BY c.id, c.nome, c.icone
      ORDER BY total DESC
    `);

    const problemasPendentes = await pool.query(`
      SELECT p.*, m.nome as maquina_nome, c.icone
      FROM problemas p
      JOIN maquinas m ON p.maquina_id = m.id
      LEFT JOIN categorias c ON m.categoria_id = c.id
      WHERE p.status = 'pendente'
      ORDER BY 
        CASE p.prioridade 
          WHEN 'critica' THEN 1 
          WHEN 'alta' THEN 2 
          WHEN 'media' THEN 3 
          WHEN 'baixa' THEN 4 
        END,
        p.criado_em DESC
      LIMIT 10
    `);

    const alocacoesAtivas = await pool.query(`
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
    `);

    res.json({
      totais: stats.rows[0],
      porCategoria: categorias.rows,
      problemasPendentes: problemasPendentes.rows,
      alocacoesAtivas: alocacoesAtivas.rows
    });
  } catch (error) {
    console.error('Erro dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

// Categorias
app.get('/api/categorias', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, COUNT(m.id) as total_maquinas
      FROM categorias c
      LEFT JOIN maquinas m ON c.id = m.categoria_id
      GROUP BY c.id
      ORDER BY c.nome
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Máquinas
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
        (SELECT COUNT(*) FROM problemas WHERE maquina_id = m.id AND status = 'pendente') as problemas_pendentes
      FROM maquinas m
      LEFT JOIN categorias c ON m.categoria_id = c.id
      LEFT JOIN alocacoes a ON m.id = a.maquina_id AND a.ativa = true
      LEFT JOIN obras o ON a.obra_id = o.id
      LEFT JOIN operadores op ON a.operador_id = op.id
      WHERE 1=1
    `;
    const params = [];

    if (categoria) {
      params.push(categoria);
      query += ` AND m.categoria_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND m.status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (m.nome ILIKE $${params.length} OR m.numero_serie ILIKE $${params.length} OR m.placa ILIKE $${params.length})`;
    }

    query += ` ORDER BY m.nome`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/maquinas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const maquina = await pool.query(`
      SELECT 
        m.*,
        c.nome as categoria_nome,
        c.icone as categoria_icone
      FROM maquinas m
      LEFT JOIN categorias c ON m.categoria_id = c.id
      WHERE m.id = $1
    `, [id]);

    if (maquina.rows.length === 0) {
      return res.status(404).json({ error: 'Máquina não encontrada' });
    }

    const alocacoes = await pool.query(`
      SELECT a.*, o.nome as obra_nome, op.nome as operador_nome
      FROM alocacoes a
      LEFT JOIN obras o ON a.obra_id = o.id
      LEFT JOIN operadores op ON a.operador_id = op.id
      WHERE a.maquina_id = $1
      ORDER BY a.data_inicio DESC
    `, [id]);

    const problemas = await pool.query(`
      SELECT p.*, m.nome as maquina_nome
      FROM problemas p
      JOIN maquinas m ON p.maquina_id = m.id
      WHERE p.maquina_id = $1
      ORDER BY p.criado_em DESC
    `, [id]);

    res.json({
      maquina: maquina.rows[0],
      alocacoes: alocacoes.rows,
      problemas: problemas.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/maquinas', async (req, res) => {
  try {
    const { 
      categoria_id, nome, numero_serie, placa, local_compra,
      numero_nota, valor_locacao, combustivel, status_financeiro,
      status, tem_operador, observacao
    } = req.body;

    const result = await pool.query(`
      INSERT INTO maquinas (
        categoria_id, nome, numero_serie, placa, local_compra,
        numero_nota, valor_locacao, combustivel, status_financeiro,
        status, tem_operador, observacao
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [
      categoria_id, nome, numero_serie, placa, local_compra,
      numero_nota, valor_locacao, combustivel, status_financeiro,
      status, tem_operador, observacao
    ]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/maquinas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      categoria_id, nome, numero_serie, placa, local_compra,
      numero_nota, valor_locacao, combustivel, status_financeiro,
      status, tem_operador, observacao
    } = req.body;

    const result = await pool.query(`
      UPDATE maquinas SET
        categoria_id = $1, nome = $2, numero_serie = $3, placa = $4,
        local_compra = $5, numero_nota = $6, valor_locacao = $7,
        combustivel = $8, status_financeiro = $9, status = $10,
        tem_operador = $11, observacao = $12, updated_at = NOW()
      WHERE id = $13
      RETURNING *
    `, [
      categoria_id, nome, numero_serie, placa, local_compra,
      numero_nota, valor_locacao, combustivel, status_financeiro,
      status, tem_operador, observacao, id
    ]);

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obras
app.get('/api/obras', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, 
        (SELECT COUNT(*) FROM alocacoes WHERE obra_id = o.id AND ativa = true) as maquinas_ativas
      FROM obras o
      ORDER BY o.ativa DESC, o.nome
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/obras', async (req, res) => {
  try {
    const { nome, local } = req.body;
    const result = await pool.query(
      'INSERT INTO obras (nome, local) VALUES ($1, $2) RETURNING *',
      [nome, local]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/obras/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, local, ativa } = req.body;
    const result = await pool.query(
      'UPDATE obras SET nome = $1, local = $2, ativa = $3 WHERE id = $4 RETURNING *',
      [nome, local, ativa, id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/obras/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM obras WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Operadores
app.get('/api/operadores', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, 
        (SELECT COUNT(*) FROM alocacoes WHERE operador_id = o.id AND ativa = true) as alocacoes_ativas
      FROM operadores o
      WHERE o.ativo = true
      ORDER BY o.nome
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/operadores', async (req, res) => {
  try {
    const { nome, telefone } = req.body;
    const result = await pool.query(
      'INSERT INTO operadores (nome, telefone) VALUES ($1, $2) RETURNING *',
      [nome, telefone]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/operadores/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, telefone, ativo } = req.body;
    const result = await pool.query(
      'UPDATE operadores SET nome = $1, telefone = $2, ativo = $3 WHERE id = $4 RETURNING *',
      [nome, telefone, ativo, id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/operadores/:id', async (req, res) => {
  try {
    await pool.query('UPDATE operadores SET ativo = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Alocações
app.get('/api/alocacoes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        a.*,
        m.nome as maquina_nome,
        m.numero_serie,
        m.placa,
        c.nome as categoria_nome,
        c.icone,
        o.nome as obra_nome,
        o.local as obra_local,
        op.nome as operador_nome
      FROM alocacoes a
      JOIN maquinas m ON a.maquina_id = m.id
      LEFT JOIN categorias c ON m.categoria_id = c.id
      LEFT JOIN obras o ON a.obra_id = o.id
      LEFT JOIN operadores op ON a.operador_id = op.id
      WHERE a.ativa = true
      ORDER BY a.data_inicio DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/alocacoes', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { maquina_id, obra_id, operador_id, data_inicio, observacao } = req.body;
    
    // Criar alocação
    const result = await client.query(`
      INSERT INTO alocacoes (maquina_id, obra_id, operador_id, data_inicio, observacao)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [maquina_id, obra_id, operador_id, data_inicio, observacao]);

    // Atualizar status da máquina
    await client.query(
      "UPDATE maquinas SET status = 'locado', updated_at = NOW() WHERE id = $1",
      [maquina_id]
    );

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.put('/api/alocacoes/:id/encerrar', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    
    // Encerrar alocação
    const result = await client.query(`
      UPDATE alocacoes 
      SET ativa = false, data_fim = CURRENT_DATE 
      WHERE id = $1 
      RETURNING *
    `, [id]);

    if (result.rows.length > 0) {
      // Liberar máquina
      await client.query(
        "UPDATE maquinas SET status = 'disponivel', updated_at = NOW() WHERE id = $1",
        [result.rows[0].maquina_id]
      );
    }

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
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

    if (status) {
      params.push(status);
      query += ` AND p.status = $${params.length}`;
    }
    if (prioridade) {
      params.push(prioridade);
      query += ` AND p.prioridade = $${params.length}`;
    }

    query += ` ORDER BY 
      CASE p.prioridade 
        WHEN 'critica' THEN 1 
        WHEN 'alta' THEN 2 
        WHEN 'media' THEN 3 
        WHEN 'baixa' THEN 4 
      END,
      p.criado_em DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/problemas', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { maquina_id, descricao, tipo, prioridade, reportado_por } = req.body;
    
    const result = await client.query(`
      INSERT INTO problemas (maquina_id, descricao, tipo, prioridade, reportado_por)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [maquina_id, descricao, tipo, prioridade, reportado_por]);

    // Se for prioridade crítica, colocar máquina em manutenção
    if (prioridade === 'critica') {
      await client.query(
        "UPDATE maquinas SET status = 'manutencao', updated_at = NOW() WHERE id = $1",
        [maquina_id]
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

app.put('/api/problemas/:id/resolver', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { observacao_resolucao } = req.body;

    const result = await client.query(`
      UPDATE problemas 
      SET status = 'resolvido', 
          observacao_resolucao = $1, 
          resolvido_em = NOW()
      WHERE id = $2
      RETURNING *
    `, [observacao_resolucao, id]);

    // Verificar se ainda tem problemas pendentes nesta máquina
    const pendentes = await client.query(
      'SELECT COUNT(*) FROM problemas WHERE maquina_id = $1 AND status = $2',
      [result.rows[0].maquina_id, 'pendente']
    );

    // Se não houver mais pendentes, voltar máquina para disponível
    if (parseInt(pendentes.rows[0].count) === 0) {
      await client.query(
        "UPDATE maquinas SET status = 'disponivel', updated_at = NOW() WHERE id = $1 AND status = 'manutencao'",
        [result.rows[0].maquina_id]
      );
    }

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.delete('/api/problemas/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM problemas WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== INICIAR SERVIDOR =====
async function startServer() {
  await initDatabase();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🗄️  API: http://localhost:${PORT}/api`);
  });
}

startServer();
