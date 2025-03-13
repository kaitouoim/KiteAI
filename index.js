import fetch from 'node-fetch';
import chalk from 'chalk';
import fs from 'fs/promises';
import readline from 'readline';
import { displayHeader } from './banner.js';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Fungsi untuk menunggu tombol ditekan
const waitForKeyPress = async () => {
  process.stdin.setRawMode(true);
  return new Promise((resolve) => {
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      resolve();
    });
  });
};

// Fungsi untuk memuat daftar wallet dari file wallets.txt
async function loadWallets() {
  try {
    const data = await fs.readFile('wallets.txt', 'utf8');
    const wallets = data
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    if (wallets.length === 0) {
      throw new Error('Tidak ada wallet yang ditemukan di wallets.txt');
    }
    return wallets;
  } catch (err) {
    console.log(chalk.cyan('[ERROR] Gagal membaca wallets.txt:'), chalk.white(err.message));
    process.exit(1);
  }
}

// Fungsi untuk memuat daftar proxy dari file proxies.txt
async function loadProxies() {
  try {
    const data = await fs.readFile('proxies.txt', 'utf8');
    return data
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((proxy) => {
        if (proxy.includes('://')) {
          const url = new URL(proxy);
          return {
            protocol: url.protocol.replace(':', ''),
            host: url.hostname,
            port: url.port,
            auth: url.username ? `${url.username}:${url.password}` : '',
          };
        } else {
          const [protocol, host, port, user, pass] = proxy.split(':');
          return {
            protocol: protocol.replace('//', ''),
            host,
            port,
            auth: user && pass ? `${user}:${pass}` : '',
          };
        }
      });
  } catch (err) {
    console.log(chalk.cyan('[INFO] File proxies.txt tidak ditemukan. Menggunakan koneksi langsung.'));
    return [];
  }
}

// Fungsi untuk membuat agent proxy
function createAgent(proxy) {
  if (!proxy) return null;
  const { protocol, host, port, auth } = proxy;
  const proxyUrl = `${protocol}://${auth ? `${auth}@` : ''}${host}:${port}`;
  return protocol.startsWith('socks') ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
}

// Definisi endpoint AI
const AI_ENDPOINTS = {
  "https://deployment-uu9y1z4z85rapgwkss1muuiz.stag-vxzy.zettablock.com/main": {
    agent_id: "deployment_UU9y1Z4Z85RAPGwkss1mUUiZ",
    name: "Kite AI Assistant",
    questions: [
      "Apa pembaruan terbaru di Kite AI?",
      "Fitur apa yang akan datang di Kite AI?",
      "Bagaimana Kite AI meningkatkan alur kerja pengembangan?",
    ],
  },
  "https://deployment-ecz5o55dh0dbqagkut47kzyc.stag-vxzy.zettablock.com/main": {
    agent_id: "deployment_ECz5O55dH0dBQaGKuT47kzYC",
    name: "Crypto Price Assistant",
    questions: [
      "Apa sentimen pasar saat ini untuk Solana?",
      "Analisis pergerakan harga Bitcoin dalam satu jam terakhir.",
    ],
  },
};

// Kelas untuk menyimpan statistik wallet
class WalletStatistics {
  constructor() {
    this.agentInteractions = {};
    for (const endpoint in AI_ENDPOINTS) {
      this.agentInteractions[AI_ENDPOINTS[endpoint].name] = 0;
    }
    this.totalPoints = 0;
    this.totalInteractions = 0;
    this.lastInteractionTime = null;
    this.successfulInteractions = 0;
    this.failedInteractions = 0;
  }
}

// Kelas untuk sesi wallet
class WalletSession {
  constructor(walletAddress, sessionId) {
    this.walletAddress = walletAddress;
    this.sessionId = sessionId;
    this.dailyPoints = 0;
    this.startTime = new Date();
    this.nextResetTime = new Date(this.startTime.getTime() + 24 * 60 * 60 * 1000);
    this.statistics = new WalletStatistics();
  }

  updateStatistics(agentName, success = true) {
    this.statistics.agentInteractions[agentName]++;
    this.statistics.totalInteractions++;
    this.statistics.lastInteractionTime = new Date();
    if (success) {
      this.statistics.successfulInteractions++;
      this.statistics.totalPoints += 10; // Poin per interaksi sukses
    } else {
      this.statistics.failedInteractions++;
    }
  }

  printStatistics() {
    console.log(chalk.cyan(`\n[Session ${this.sessionId}] [${this.walletAddress}] Statistik Saat Ini`));
    console.log(chalk.white('────────────────────────────────────────────────────────────'));
    console.log(chalk.green('Total Poin:'), chalk.white(this.statistics.totalPoints));
    console.log(chalk.green('Total Interaksi:'), chalk.white(this.statistics.totalInteractions));
    console.log(chalk.green('Berhasil:'), chalk.white(this.statistics.successfulInteractions));
    console.log(chalk.green('Gagal:'), chalk.white(this.statistics.failedInteractions));
    console.log(chalk.green('Interaksi Terakhir:'), chalk.white(this.statistics.lastInteractionTime?.toISOString() || 'Belum Ada'));
    console.log(chalk.white('────────────────────────────────────────────────────────────\n'));
  }
}

// Fungsi untuk menampilkan progress bar
function showProgressBar(percentage) {
  const barLength = 50;
  const filled = Math.round((percentage / 100) * barLength);
  const empty = barLength - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percentage}%`;
}

// Kelas utama untuk automasi Kite AI
class KiteAIAutomation {
  constructor(walletAddress, proxyList = [], sessionId) {
    this.session = new WalletSession(walletAddress, sessionId);
    this.proxyList = proxyList;
    this.currentProxyIndex = 0;
    this.MAX_DAILY_POINTS = 200;
    this.POINTS_PER_INTERACTION = 10;
    this.MAX_DAILY_INTERACTIONS = this.MAX_DAILY_POINTS / this.POINTS_PER_INTERACTION;
    this.isRunning = true;
    this.minDelay = 10; // Delay minimum (dalam detik)
    this.maxDelay = 20; // Delay maksimum (dalam detik)
    this.delayType = 'random'; // Jenis delay: 'fixed' atau 'random'
  }

  getCurrentProxy() {
    if (this.proxyList.length === 0) return null;
    return this.proxyList[this.currentProxyIndex];
  }

  rotateProxy() {
    if (this.proxyList.length === 0) return null;
    this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxyList.length;
    const proxy = this.getCurrentProxy();
    this.logMessage(`Memutar ke proxy: ${proxy.protocol}://${proxy.host}:${proxy.port}`);
    return proxy;
  }

  logMessage(message) {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const sessionPrefix = chalk.cyan(`[Session ${this.session.sessionId}]`);
    const walletPrefix = chalk.green(`[${this.session.walletAddress.slice(0, 6)}...]`);
    console.log(chalk.white(`[${timestamp}]`), sessionPrefix, walletPrefix, chalk.white(message));
  }

  async run() {
    this.logMessage('Memulai sistem interaksi otomatis Kite AI');
    this.logMessage(`Wallet: ${this.session.walletAddress}`);
    this.logMessage(`Target Harian: ${this.MAX_DAILY_POINTS} poin (${this.MAX_DAILY_INTERACTIONS} interaksi)`);
    this.logMessage(`Reset Berikutnya: ${this.session.nextResetTime.toISOString().replace('T', ' ').slice(0, 19)}`);

    let interactionCount = 0;
    while (this.isRunning) {
      // Cek apakah poin harian sudah mencapai batas maksimal
      if (this.session.dailyPoints >= this.MAX_DAILY_POINTS) {
        this.logMessage(`Batas harian (${this.MAX_DAILY_POINTS} poin) telah tercapai. Menunggu reset...`);
        const waitTime = this.session.nextResetTime - new Date();
        if (waitTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
        this.session.dailyPoints = 0; // Reset poin harian
        this.session.nextResetTime = new Date(new Date().getTime() + 24 * 60 * 60 * 1000); // Set ulang waktu reset
        this.logMessage(`Reset harian berhasil. Mulai interaksi baru.`);
      }

      interactionCount++;
      console.log(chalk.cyan(`\n[Session ${this.session.sessionId}] [${this.session.walletAddress}] ────────────────────────────────`));
      this.logMessage(`Interaksi #${interactionCount}`);

      // Simulasikan interaksi berhasil
      const success = true; // Ganti dengan logika interaksi yang sebenarnya
      if (success) {
        this.session.dailyPoints += this.POINTS_PER_INTERACTION; // Tambahkan poin
      }

      this.logMessage(`Progress: ${this.session.dailyPoints}/${this.MAX_DAILY_POINTS} poin`);

      // Tampilkan progress bar
      const progress = (this.session.dailyPoints / this.MAX_DAILY_POINTS) * 100;
      console.log(chalk.green(showProgressBar(progress)));

      // Delay berdasarkan jenis delay yang dipilih
      const delay = this.getNextDelay();
      this.logMessage(`Menunggu ${delay.toFixed(1)} detik...`);

      // Countdown detik
      let remainingTime = Math.floor(delay); // Bulatkan delay ke bilangan bulat
      const countdownInterval = setInterval(() => {
        process.stdout.write(`\r${chalk.yellow(`Countdown: ${remainingTime} detik...`)}`);
        remainingTime--;
        if (remainingTime < 0) {
          clearInterval(countdownInterval);
          process.stdout.write('\n');
        }
      }, 1000);

      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      clearInterval(countdownInterval); // Hentikan countdown setelah delay selesai
    }
  }

  getNextDelay() {
    if (this.delayType === 'fixed') {
      return this.minDelay; // Gunakan delay tetap (minDelay)
    } else {
      // Gunakan delay acak dalam rentang minDelay dan maxDelay
      return this.minDelay + Math.random() * (this.maxDelay - this.minDelay);
    }
  }

  setDelay(minDelay, maxDelay, delayType = 'random') {
    if (delayType === 'fixed') {
      // Validasi untuk delay tetap
      if (!isNaN(minDelay) && minDelay >= 0) {
        this.minDelay = minDelay;
        this.maxDelay = minDelay; // Untuk delay tetap, minDelay dan maxDelay sama
        this.delayType = 'fixed';
        this.logMessage(`Delay tetap berhasil diubah menjadi ${minDelay} detik.`);
      } else {
        console.log(chalk.red('Input tidak valid. Pastikan delay tetap >= 0.'));
      }
    } else if (delayType === 'random') {
      // Validasi untuk delay acak
      if (!isNaN(minDelay) && !isNaN(maxDelay) && minDelay >= 0 && maxDelay > minDelay) {
        this.minDelay = minDelay;
        this.maxDelay = maxDelay;
        this.delayType = 'random';
        this.logMessage(`Delay acak berhasil diubah menjadi ${minDelay}-${maxDelay} detik.`);
      } else {
        console.log(chalk.red('Input tidak valid. Pastikan minDelay >= 0 dan maxDelay > minDelay.'));
      }
    } else {
      console.log(chalk.red('Jenis delay tidak valid. Pilih "fixed" atau "random".'));
    }
  }
}

// Fungsi untuk menampilkan menu
function showMenu() {
  console.log(chalk.cyan('\nMenu Utama'));
  console.log(chalk.white('────────────────────────────────────────────────────────────'));
  console.log(chalk.green('1. Mulai Interaksi Otomatis'));
  console.log(chalk.green('2. Konfigurasi Delay'));
  console.log(chalk.green('   a. Delay Tetap'));
  console.log(chalk.green('   b. Delay Acak'));
  console.log(chalk.green('3. Keluar'));
  console.log(chalk.white('────────────────────────────────────────────────────────────'));
}

// Fungsi utama
async function main() {
  console.clear();
  displayHeader(); // Tampilkan header
  console.log(chalk.bold.white('=========================================='));
  console.log(chalk.bold.red('DISCLAIMER !!!'), chalk.bold.yellow('Do not modify this script'));
  console.log(chalk.bold.red('ALL RISKS ARE YOUR RESPONSIBILITY\n\n'));
  console.log(chalk.cyan('Tekan tombol apa saja untuk melanjutkan...'));

  await waitForKeyPress();
  console.clear();
  displayHeader(); // Tampilkan header lagi

  // Muat wallet dan proxy
  const wallets = await loadWallets();
  const proxyList = await loadProxies();
  console.log(chalk.cyan('Dimuat:'), chalk.green(`${wallets.length} wallet dan ${proxyList.length} proxy\n`));

  // Buat instance untuk setiap wallet
  const instances = wallets.map((wallet, index) => new KiteAIAutomation(wallet, proxyList, index + 1));

  // Tampilkan menu
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    showMenu();
    const choice = await new Promise((resolve) => {
      rl.question(chalk.cyan('Pilih opsi (1-3): '), resolve);
    });

    switch (choice) {
      case '1':
        console.clear();
        displayHeader();
        console.log(chalk.cyan('Memulai interaksi otomatis...\n'));
        await Promise.all(instances.map((instance) => instance.run()));
        break;
      case '2':
        console.clear();
        displayHeader();
        const subChoice = await new Promise((resolve) => {
          rl.question(chalk.cyan('Pilih sub-menu (a/b): '), resolve);
        });

        switch (subChoice) {
          case 'a':
            const fixedDelay = await new Promise((resolve) => {
              rl.question(chalk.cyan('Masukkan delay tetap (dalam detik): '), resolve);
            });
            const fixed = parseFloat(fixedDelay);
            instances.forEach((instance) => instance.setDelay(fixed, fixed, 'fixed'));
            break;
          case 'b':
            const minDelayRandom = await new Promise((resolve) => {
              rl.question(chalk.cyan('Masukkan delay minimum (dalam detik): '), resolve);
            });
            const maxDelayRandom = await new Promise((resolve) => {
              rl.question(chalk.cyan('Masukkan delay maksimum (dalam detik): '), resolve);
            });
            const minRandom = parseFloat(minDelayRandom);
            const maxRandom = parseFloat(maxDelayRandom);
            instances.forEach((instance) => instance.setDelay(minRandom, maxRandom, 'random'));
            break;
          default:
            console.log(chalk.red('Pilihan tidak valid. Silakan coba lagi.'));
        }
        break;
      case '3':
        console.log(chalk.cyan('Keluar dari aplikasi.'));
        rl.close();
        process.exit(0);
      default:
        console.log(chalk.red('Pilihan tidak valid. Silakan coba lagi.'));
    }
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log(chalk.yellow('\nMenghentikan proses dengan aman...'));
  process.exit(0);
});

// Jalankan aplikasi
main().catch((error) => {
  console.error(chalk.red('Error fatal:'), error.message);
  process.exit(1);
});