'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

function listFiles(dir, prefix = '') {
	const out = [];
	for (const entry of fs.readdirSync(dir)) {
		if (['node_modules', 'dist', '.git'].includes(entry)) continue;
		const full = path.join(dir, entry);
		const relative = prefix ? `${prefix}/${entry}` : entry;
		if (fs.statSync(full).isDirectory()) out.push(...listFiles(full, relative));
		else out.push(relative);
	}
	return out;
}

test('package.json follows the n8n community node conventions', () => {
	assert.match(pkg.name, /^n8n-nodes-/);
	assert.ok(pkg.keywords.includes('n8n-community-node-package'));
	assert.equal(pkg.license, 'MIT');
	assert.deepEqual(pkg.files.filter((entry) => !entry.startsWith('!')), ['dist']);
	assert.equal(pkg.dependencies, undefined, 'verified community nodes have no runtime dependencies');
	assert.deepEqual(Object.keys(pkg.peerDependencies), ['n8n-workflow']);
	assert.equal(pkg.n8n.n8nNodesApiVersion, 1);
	for (const entry of [...pkg.n8n.credentials, ...pkg.n8n.nodes]) {
		assert.match(entry, /^dist\//);
		const source = entry.replace(/^dist\//, '').replace(/\.js$/, '.ts');
		assert.ok(fs.existsSync(path.join(ROOT, source)), `${source} exists`);
		assert.ok(fs.existsSync(path.join(ROOT, entry)), `${entry} is built`);
	}
	for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) assert.equal(pkg.scripts[script], undefined, script);
});

test('no other meeting-notes product names, no secrets, English-only node texts', () => {
	// Kept base64-encoded so the names never appear in this repo's text.
	const names = Buffer.from(
		'dGltZWxlc3N8ZmlyZWZsaWVzfG90dGVyLmFpfGZhdGhvbXx0bGR2fHRsO2R2fHJlYWQuYWl8YXZvbWF8Z29uZy5pb3xrcmlzcHxzdXBlcm5vcm1hbHx0YWN0aXF8c2VtYmx5fGdyYWluLmNvbXxub3R0YXxhaXJncmFtfGJsdWVkb3Q=',
		'base64',
	)
		.toString('utf8')
		.split('|')
		.map((name) => name.replace(/[.;]/g, (c) => `\\${c}`));
	const banned = new RegExp(`\\b(${names.join('|')})\\b|-compat${'ible'}\\b`, 'i');
	for (const file of listFiles(ROOT)) {
		const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
		assert.ok(!banned.test(content), `${file}: ${(content.match(banned) || [])[0]}`);
		assert.ok(!/msk_(live|org)_[A-Za-z0-9]{12,}/.test(content), `${file}: looks like an API key`);
		if (!file.startsWith('test/')) assert.ok(!/whsec_[A-Za-z0-9+/]{20,}/.test(content), `${file}: looks like a signing secret`);
		if (/^(nodes|credentials)\//.test(file) && file.endsWith('.ts')) {
			assert.ok(!/[֐-׿]/.test(content), `${file}: node texts are English only (n8n verification)`);
		}
	}
});
