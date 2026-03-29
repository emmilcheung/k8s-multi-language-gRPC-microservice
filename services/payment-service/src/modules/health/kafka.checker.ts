import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import net from 'node:net';

@Injectable()
export class KafkaChecker {
  constructor(private readonly config: ConfigService) {}

  async ping(): Promise<void> {
    const broker = this.config.getOrThrow<string>('KAFKA_BROKERS').split(',')[0].trim();
    const [host, portText] = broker.split(':');
    const port = Number(portText || 9092);

    await new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();

      const finish = (err?: Error) => {
        socket.destroy();
        if (err) {
          reject(err);
          return;
        }
        resolve();
      };

      socket.setTimeout(1000);
      socket.once('connect', () => finish());
      socket.once('timeout', () => finish(new Error('kafka ping timeout')));
      socket.once('error', (err) => finish(err));
      socket.connect(port, host);
    });
  }
}
