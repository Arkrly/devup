#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const { execa } = require('execa');
const { spawn, exec } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const inquirer = require('inquirer');
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: { colorize: true }
  } : undefined
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason }, 'Unhandled Promise Rejection');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught Exception');
  process.exit(1);
});

const program = new Command();

program
  .name('devup')
  .description('Universal dev server + Cloudflare tunnel launcher')
  .version('1.0.0')
  .option('-p, --port <port>', 'Override port (single service)')
  .option('-c, --cmd <command>', 'Override dev command')
  .argument('[init]', 'Initialize devup.config.json for current project')
  .parse(process.argv);

const opts = program.opts();
const args = program.args;

const serviceProcesses = [];
const tunnelProcesses = [];
const runningServices = [];

function log(message) {
  logger.info(message);
}

function printHeader() {
  logger.info('🚀 devup — universal dev tunnel');
}

function printDetected(type, cmd) {
  logger.info({ type, cmd }, 'Detected project type');
}

function printServicesTable(services) {
  const maxNameLen = Math.max(...services.map(s => s.name.length));
  const maxUrlLen = Math.max(...services.map(s => (s.url || 'waiting...').length));
  
  const border = ' ┌' + '─'.repeat(maxNameLen + 2) + '┬' + '─'.repeat(Math.max(maxUrlLen, 30)) + '┐ ';
  const row = (name, url) => {
    const paddedName = name.padEnd(maxNameLen + 2);
    const paddedUrl = (url || 'waiting...').padEnd(Math.max(maxUrlLen, 30));
    return ` │ ${paddedName}→  ${paddedUrl}│`;
  };
  const bottomBorder = ' └' + '─'.repeat(maxNameLen + 2) + '┴' + '─'.repeat(Math.max(maxUrlLen, 30)) + '┘ ';

  logger.info(border);
  for (const s of services) {
    logger.info(row(s.name, s.url));
  }
  logger.info(bottomBorder);
}

function printTimeoutWarning(port) {
  logger.warn({ port }, 'Port did not open within 60 seconds. Dev server is still running.');
}

function checkCloudflaredInstalled() {
  try {
    require.resolve('cloudflared/bin/cloudflared');
    return true;
  } catch {
    return false;
  }
}

function getCloudflaredPath() {
  try {
    return require.resolve('cloudflared/bin/cloudflared');
  } catch {
    return 'cloudflared';
  }
}

function printCloudflaredInstallHint() {
  const platform = os.platform();
  if (platform === 'darwin') {
    logger.warn('Please install cloudflared: brew install cloudflared');
  } else {
    logger.warn('Please install cloudflared: yay -S cloudflared');
  }
}

async function readConfigFile(filePath) {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return content;
  } catch {
    return null;
  }
}

async function parseJsonConfig() {
  const configPath = path.join(process.cwd(), 'devup.config.json');
  try {
    const content = await fs.promises.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    if (error instanceof SyntaxError) {
      logger.warn({ configPath, err: error }, 'Invalid JSON in config file. Skipping.');
      return null;
    }
    throw error;
  }
}

async function detectProjectType() {
  const cwd = process.cwd();
  
  if (fs.existsSync(path.join(cwd, 'devup.config.json'))) {
    return null;
  }
  
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    const pkg = JSON.parse(await fs.promises.readFile(path.join(cwd, 'package.json'), 'utf-8'));
    
    const hasYarnLock = fs.existsSync(path.join(cwd, 'yarn.lock'));
    const hasPnpmLock = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'));
    const hasNpmLock = fs.existsSync(path.join(cwd, 'package-lock.json'));
    
    let pm = 'npm';
    if (hasPnpmLock) pm = 'pnpm';
    else if (hasYarnLock) pm = 'yarn';
    
    if (pkg.scripts?.dev) {
      const isNext = pkg.dependencies?.next || pkg.devDependencies?.next;
      const isVite = pkg.devDependencies?.vite || pkg.dependencies?.vite;
      const isExpo = pkg.dependencies?.expo || pkg.devDependencies?.expo;
      const isRemix = pkg.dependencies?.remix || pkg.devDependencies?.remix;
      
      let type = 'Node.js';
      if (isNext) type = 'Next.js';
      else if (isVite) type = 'Vite';
      else if (isExpo) type = 'Expo';
      else if (isRemix) type = 'Remix';
      
      return { type, cmd: `${pm} run dev`, pm };
    }
    if (pkg.scripts?.start) {
      return { type: 'Node.js', cmd: `${pm} run start`, pm };
    }
    if (pkg.scripts?.serve) {
      return { type: 'Node.js', cmd: `${pm} run serve`, pm };
    }
  }
  
  if (fs.existsSync(path.join(cwd, 'pom.xml'))) {
    return { type: 'Maven (Spring Boot)', cmd: 'mvn spring-boot:run', pm: 'mvn' };
  }
  
  if (fs.existsSync(path.join(cwd, 'build.gradle'))) {
    return { type: 'Gradle (Spring Boot)', cmd: './gradlew bootRun', pm: 'gradle' };
  }
  
  if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
    const content = await readConfigFile(path.join(cwd, 'pyproject.toml'));
    if (content && (content.includes('fastapi') || content.includes('uvicorn'))) {
      return { type: 'Python (FastAPI)', cmd: 'uv run uvicorn main:app --reload', pm: 'uv' };
    }
    return { type: 'Python', cmd: 'python -m pip install -r requirements.txt && python main.py', pm: 'python' };
  }
  
  if (fs.existsSync(path.join(cwd, 'manage.py'))) {
    return { type: 'Django', cmd: 'python manage.py runserver', pm: 'python' };
  }
  
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return { type: 'Go', cmd: 'go run .', pm: 'go' };
  }
  
  if (fs.existsSync(path.join(cwd, 'docker-compose.yml'))) {
    return { type: 'Docker Compose', cmd: 'docker compose up', pm: 'docker' };
  }
  
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return { type: 'Rust', cmd: 'cargo run', pm: 'cargo' };
  }
  
  return { type: 'Unknown', cmd: 'npm run dev', pm: 'npm' };
}

async function detectPortFromConfig() {
  const cwd = process.cwd();
  
  const viteConfig = await findFile(['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts']);
  if (viteConfig) {
    const content = await readConfigFile(viteConfig);
    const portMatch = content?.match(/port\s*:\s*(\d+)/);
    if (portMatch) return parseInt(portMatch[1]);
    
    const serverMatch = content?.match(/server\s*:\s*\{([^}]+)\}/s);
    if (serverMatch) {
      const portInServer = serverMatch[1].match(/port\s*:\s*(\d+)/);
      if (portInServer) return parseInt(portInServer[1]);
    }
  }
  
  const appProps = await findFile(['application.properties', 'application.yml', 'application.yaml']);
  if (appProps) {
    const content = await readConfigFile(appProps);
    const portMatch = content?.match(/server\.port\s*=\s*(\d+)/) || content?.match(/port:\s*(\d+)/);
    if (portMatch) return parseInt(portMatch[1]);
  }
  
  const pomXml = path.join(cwd, 'pom.xml');
  if (fs.existsSync(pomXml)) {
    const content = await readConfigFile(pomXml);
    const portMatch = content?.match(/<server\.port>(\d+)<\/server\.port>/);
    if (portMatch) return parseInt(portMatch[1]);
  }
  
  const envFiles = ['.env', '.env.local', '.env.development', '.env.dev'];
  for (const envFile of envFiles) {
    const envPath = path.join(cwd, envFile);
    if (fs.existsSync(envPath)) {
      const content = await readConfigFile(envPath);
      const portMatch = content?.match(/PORT\s*=\s*(\d+)/) 
        || content?.match(/VITE_PORT\s*=\s*(\d+)/)
        || content?.match(/SERVER_PORT\s*=\s*(\d+)/);
      if (portMatch) return parseInt(portMatch[1]);
    }
  }
  
  const pyproject = path.join(cwd, 'pyproject.toml');
  if (fs.existsSync(pyproject)) {
    const content = await readConfigFile(pyproject);
    const portMatch = content?.match(/port\s*=\s*(\d+)/);
    if (portMatch) return parseInt(portMatch[1]);
  }
  
  return null;
}

async function findFile(files) {
  const cwd = process.cwd();
  for (const file of files) {
    const filePath = path.join(cwd, file);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

async function getOpenPorts() {
  return new Promise((resolve) => {
    const ports = new Set();
    const platform = os.platform();
    
    const cmd = platform === 'darwin' 
      ? 'lsof -i -P -n | grep LISTEN'
      : 'ss -tlnp';
    
    exec(cmd, (error, stdout) => {
      if (error) {
        resolve(ports);
        return;
      }
      
      const lines = stdout.split('\n');
      for (const line of lines) {
        const portMatch = line.match(/:(\d+)\s/);
        if (portMatch) {
          ports.add(parseInt(portMatch[1]));
        }
      }
      resolve(ports);
    });
  });
}

async function checkPortWithPid(port, pid, platform) {
  if (platform !== 'linux') return true;
  
  try {
    const { stdout } = await execa('ss', ['-tlnp']);
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.includes(`:${port}`) && line.includes(`pid=${pid}`)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function waitForPort(pid, initialPorts, expectedPort, timeout = 60000) {
  const startTime = Date.now();
  const platform = os.platform();
  
  while (Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const currentPorts = await getOpenPorts();
    
    // First, check if the expected port is available (if provided)
    if (expectedPort && currentPorts.has(expectedPort) && !initialPorts.has(expectedPort)) {
      const pidMatch = await checkPortWithPid(expectedPort, pid, platform);
      if (pidMatch || platform !== 'linux') {
        return expectedPort;
      }
    }
    
    // Otherwise, look for any new port
    for (const port of currentPorts) {
      if (!initialPorts.has(port) && port > 1024) {
        // Skip if this is the expected port (we already checked above)
        if (expectedPort && port === expectedPort) continue;
        
        const pidMatch = await checkPortWithPid(port, pid, platform);
        if (pidMatch || platform !== 'linux') {
          return port;
        }
      }
    }
  }
  
  return null;
}

async function startTunnel(port, serviceName) {
  return new Promise((resolve, reject) => {
    const cloudflaredPath = getCloudflaredPath();
    const tunnel = spawn(cloudflaredPath, ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let url = null;
    let errorOutput = '';
    let resolveOnce = null;
    
    const cleanup = () => {
      if (resolveOnce) {
        clearTimeout(resolveOnce);
        resolveOnce = null;
      }
    };
    
    // Timeout if no URL is received
    resolveOnce = setTimeout(() => {
      if (!url) {
        const service = runningServices.find(s => s.name === serviceName);
        if (service) service.url = '(timeout)';
        logger.warn({ serviceName }, 'Tunnel startup timed out');
        resolve(null);
      }
    }, 30000);
    
    tunnel.stdout.on('data', (data) => {
      const output = data.toString();
      const urlMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !url) {
        url = urlMatch[0];
        cleanup();
        const service = runningServices.find(s => s.name === serviceName);
        if (service) service.url = url;
        logger.info({ serviceName, url }, 'Tunnel ready');
        resolve(url);
      }
    });
    
    tunnel.stderr.on('data', (data) => {
      const output = data.toString();
      errorOutput += output;
      
      if (output.includes('No valid token') || output.includes('not logged in')) {
        cleanup();
        logger.error({ serviceName }, 'cloudflared not authenticated. Run cloudflared tunnel login first.');
        reject(new Error(`cloudflared not authenticated for ${serviceName}`));
        tunnel.kill();
      } else if (output.includes('error') || output.includes('Error') || output.includes('failed')) {
        logger.debug({ serviceName, output: output.trim() }, 'Tunnel stderr');
      }
    });
    
    tunnel.on('error', (error) => {
      cleanup();
      logger.error({ serviceName, err: error }, 'Failed to start tunnel');
      reject(error);
    });
    
    tunnel.on('close', (code) => {
      cleanup();
      if (!url && code !== 0) {
        logger.error({ serviceName, code }, 'Tunnel exited with error');
        reject(new Error(`Tunnel exited with code ${code}`));
      }
    });
    
    tunnelProcesses.push({ process: tunnel, port, name: serviceName });
  });
}

function countBraces(str) {
  let count = 0;
  for (const char of str) {
    if (char === '{') count++;
    if (char === '}') count--;
  }
  return count;
}

async function patchViteConfig() {
  const cwd = process.cwd();
  const configFiles = ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts'];
  
  for (const configFile of configFiles) {
    const configPath = path.join(cwd, configFile);
    if (!fs.existsSync(configPath)) continue;
    
    const content = await fs.promises.readFile(configPath, 'utf-8');
    
    if (content.includes('allowedHosts')) continue;
    
    let modified = false;
    let newContent = content;
    
    if (content.includes('server:')) {
      if (content.includes('server: {')) {
        // Find the server block by matching braces properly
        const serverMatch = content.match(/server:\s*\{/);
        if (serverMatch) {
          const startIdx = serverMatch.index;
          let braceCount = 0;
          let endIdx = startIdx;
          
          for (let i = startIdx; i < content.length; i++) {
            if (content[i] === '{') braceCount++;
            if (content[i] === '}') braceCount--;
            if (braceCount === 0 && i > startIdx) {
              endIdx = i + 1;
              break;
            }
          }
          
          const serverBlock = content.substring(startIdx, endIdx);
          if (!serverBlock.includes('allowedHosts')) {
            newContent = content.substring(0, endIdx - 1) + ' allowedHosts: \'all\',' + content.substring(endIdx - 1);
            modified = true;
          }
        }
      }
    } else if (content.includes('export default')) {
      newContent = content.replace(
        /export default\s+(\w+)/,
        `export default $1({ server: { allowedHosts: 'all' } })`
      );
      modified = true;
    }
    
    if (modified) {
      await fs.promises.writeFile(configPath, newContent);
      logger.warn({ configFile }, 'Patched to add allowedHosts: all');
      return true;
    }
  }
  
  return false;
}

async function startService(config) {
  const { name, port: configuredPort, cmd, cwd = process.cwd() } = config;
  
  logger.info({ name }, 'Starting service');
  
  const initialPorts = await getOpenPorts();
  
  const isWindows = os.platform() === 'win32';
  const shell = isWindows ? true : '/bin/sh';
  const shellArgs = isWindows ? ['-c', cmd] : ['-c', cmd];
  
  const proc = spawn(shell, shellArgs, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWindows
  });
  
  if (!isWindows) {
    proc.unref();
  }
  
  serviceProcesses.push({ process: proc, name });
  
  proc.stdout.on('data', (data) => {
    const output = data.toString();
    if (output.includes('ready in') || output.includes('Listening on') || output.includes('Started')) {
      logger.info({ name }, 'Service started');
    }
  });
  
  proc.stderr.on('data', (data) => {
    logger.debug({ name, output: data.toString().trim() }, 'Service stderr');
  });
  
  const detectedPort = await waitForPort(proc.pid, initialPorts, configuredPort);
  
  if (detectedPort) {
    logger.info({ name, port: detectedPort }, 'Service listening');
    return { name, port: detectedPort, pid: proc.pid };
  } else if (configuredPort) {
    logger.warn({ name, port: configuredPort }, 'Using configured port');
    return { name, port: configuredPort, pid: proc.pid };
  } else {
    logger.warn({ name }, 'Could not detect port, using default 3000');
    return { name, port: 3000, pid: proc.pid };
  }
}

async function initConfig() {
  const cwd = process.cwd();
  const configPath = path.join(cwd, 'devup.config.json');
  
  const projectInfo = await detectProjectType();
  const port = await detectPortFromConfig();
  
  const defaultPort = port || 3000;
  const defaultCmd = projectInfo?.cmd || 'npm run dev';
  const defaultName = projectInfo?.type ? projectInfo.type.toLowerCase().replace(/[^a-z0-9]/g, '-') : 'app';
  
  logger.info('Setting up devup config');
  
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Service name:',
      default: defaultName,
      validate: (input) => input.length > 0 ? true : 'Name is required'
    },
    {
      type: 'input',
      name: 'port',
      message: 'Port:',
      default: defaultPort,
      validate: (input) => {
        const port = parseInt(input);
        return port > 0 && port < 65536 ? true : 'Enter a valid port number';
      }
    },
    {
      type: 'input',
      name: 'cmd',
      message: 'Dev command:',
      default: defaultCmd
    },
    {
      type: 'confirm',
      name: 'addTunnel',
      message: 'Enable Cloudflare tunnel?',
      default: true
    },
    {
      type: 'confirm',
      name: 'addMore',
      message: 'Add another service?',
      default: false
    }
  ]);
  
  const services = [
    { 
      name: answers.name, 
      port: parseInt(answers.port), 
      cmd: answers.cmd, 
      cwd: '.' 
    }
  ];
  
  let currentAnswers = answers;
  while (currentAnswers.addMore) {
    const moreAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Service name:',
        validate: (input) => input.length > 0 ? true : 'Name is required'
      },
      {
        type: 'input',
        name: 'port',
        message: 'Port:',
        validate: (input) => {
          const port = parseInt(input);
          return port > 0 && port < 65536 ? true : 'Enter a valid port number';
        }
      },
      {
        type: 'input',
        name: 'cmd',
        message: 'Dev command:'
      },
      {
        type: 'confirm',
        name: 'addMore',
        message: 'Add another service?',
        default: false
      }
    ]);
    
    services.push({
      name: moreAnswers.name,
      port: parseInt(moreAnswers.port),
      cmd: moreAnswers.cmd,
      cwd: '.'
    });
    
    currentAnswers = moreAnswers;
  }
  
  const config = { services };
  
  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
  logger.info({ configPath }, 'Created config file');
  logger.info('Run "devup" to start your services.');
}

async function main() {
  if (args[0] === 'init') {
    await initConfig();
    process.exit(0);
  }
  
  printHeader();
  
  const cloudflaredInstalled = await checkCloudflaredInstalled();
  if (!cloudflaredInstalled) {
    logger.error('cloudflared is not installed.');
    printCloudflaredInstallHint();
    process.exit(1);
  }
  
  const config = await parseJsonConfig();
  
  let services = [];
  
  if (config?.services) {
    services = config.services;
  } else {
    let cmd = opts.cmd;
    let port = opts.port ? parseInt(opts.port) : null;
    let type = 'Unknown';
    
    if (!cmd || !port) {
      const detected = await detectProjectType();
      if (detected) {
        type = detected.type;
        if (!cmd) cmd = detected.cmd;
      }
    }
    
    if (!port) {
      port = await detectPortFromConfig();
    }
    
    if (!port) {
      port = 3000;
    }
    
    if (opts.cmd) {
      cmd = opts.cmd;
    }
    
    const viteConfig = await findFile(['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts']);
    if (viteConfig && !config) {
      await patchViteConfig();
    }
    
    printDetected(type, cmd);
    
    services = [{ name: 'app', port, cmd, cwd: '.' }];
  }
  
  runningServices.length = 0;
  for (const s of services) {
    runningServices.push({ name: s.name, url: null });
  }
  
  const startedServices = await Promise.allSettled(
    services.map(async (service) => {
      try {
        return await startService(service);
      } catch (error) {
        logger.error({ serviceName: service.name, err: error }, 'Failed to start service');
        return null;
      }
    })
  );
  
  const successfulStarts = startedServices
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
  
  if (successfulStarts.length === 0) {
    logger.error('No services started successfully.');
    process.exit(1);
  }
  
  logger.info('Setting up tunnels');
  
  const tunnelResults = await Promise.allSettled(
    successfulStarts.map(async (service) => {
      const hasTimeout = setTimeout(() => {
        printTimeoutWarning(service.port);
      }, 60000);
      
      try {
        await startTunnel(service.port, service.name);
        clearTimeout(hasTimeout);
      } catch (error) {
        clearTimeout(hasTimeout);
        logger.error({ serviceName: service.name, err: error }, 'Tunnel failed');
        throw error;
      }
    })
  );
  
  const failedTunnels = tunnelResults.filter(r => r.status === 'rejected');
  if (failedTunnels.length > 0 && successfulStarts.length === failedTunnels.length) {
    logger.error('All tunnels failed to start.');
  }
  
  printServicesTable(runningServices);
  logger.info('Press Ctrl+C to stop all services.');
}

async function cleanup() {
  logger.info('Stopping all services');
  
  const isWindows = os.platform() === 'win32';
  
  for (const { process: proc } of tunnelProcesses) {
    try {
      if (isWindows) {
        await execa('taskkill', ['/PID', proc.pid.toString(), '/T', '/F']);
      } else {
        try {
          process.kill(-proc.pid, 'SIGTERM');
        } catch {
          process.kill(proc.pid, 'SIGTERM');
        }
      }
    } catch (error) {
      logger.warn({ err: error }, 'Error stopping tunnel');
    }
  }
  
  for (const { process: proc } of serviceProcesses) {
    try {
      if (isWindows) {
        await execa('taskkill', ['/PID', proc.pid.toString(), '/T', '/F']);
      } else {
        try {
          process.kill(-proc.pid, 'SIGTERM');
        } catch {
          process.kill(proc.pid, 'SIGTERM');
        }
      }
    } catch (error) {
      logger.warn({ err: error }, 'Error stopping service');
    }
  }
  
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

main().catch(error => {
  logger.fatal({ err: error }, 'Fatal error');
  process.exit(1);
});
