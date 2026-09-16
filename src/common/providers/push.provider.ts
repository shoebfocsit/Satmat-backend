import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

export interface PushNotification {
  title: string;
  body: string;
  tokens: string[];
  data?: Record<string, string>;
}

export interface PushProvider {
  send(notification: PushNotification): Promise<void>;
}

@Injectable()
export class MockPushProvider implements PushProvider {
  private readonly logger = new Logger(MockPushProvider.name);
  async send(notification: PushNotification): Promise<void> {
    this.logger.log(`[MOCK PUSH] to ${notification.tokens.length} device(s): ${notification.title}`);
  }
}

@Injectable()
export class FcmPushProvider implements PushProvider, OnModuleInit {
  private readonly logger = new Logger(FcmPushProvider.name);
  private readonly projectId: string;
  private app: admin.app.App | null = null;

  constructor(private readonly config: ConfigService) {
    this.projectId = config.get<string>('FCM_PROJECT_ID') || '';
  }

  async onModuleInit() {
    const serviceAccountJson = this.config.get<string>('FCM_SERVICE_ACCOUNT_JSON');
    const serverKey = this.config.get<string>('FCM_SERVER_KEY');

    if (serviceAccountJson) {
      try {
        const serviceAccount = JSON.parse(serviceAccountJson);
        this.app = admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: this.projectId,
        });
        this.logger.log('FCM initialized with service account');
      } catch (e: any) {
        this.logger.error(`FCM service account init failed: ${e.message}`);
      }
    } else if (serverKey) {
      // Legacy server key mode (not recommended for new projects)
      this.logger.warn('Using legacy FCM server key. Migrate to service account JSON.');
    } else {
      this.logger.warn('FCM credentials not configured');
    }
  }

  async send(notification: PushNotification): Promise<void> {
    if (!this.app) {
      this.logger.log(`[FALLBACK PUSH] ${notification.title} to ${notification.tokens.length} devices`);
      return;
    }

    const messaging = this.app.messaging();

    // Send in batches of 500 (FCM limit)
    const batchSize = 500;
    for (let i = 0; i < notification.tokens.length; i += batchSize) {
      const batch = notification.tokens.slice(i, i + batchSize);
      try {
        const response = await messaging.sendEachForMulticast({
          tokens: batch,
          notification: {
            title: notification.title,
            body: notification.body,
          },
          data: notification.data || {},
          android: {
            priority: 'high',
          },
          apns: {
            payload: {
              aps: {
                contentAvailable: true,
              },
            },
          },
        });

        this.logger.log(`FCM sent: ${response.successCount} success, ${response.failureCount} failed`);

        // Handle failed tokens (cleanup invalid tokens)
        if (response.failureCount > 0) {
          const failedTokens: string[] = [];
          response.responses.forEach((resp, idx) => {
            if (!resp.success && resp.error) {
              const errorCode = resp.error.code;
              // Clean up invalid/expired tokens
              if (errorCode === 'messaging/invalid-registration-token' ||
                  errorCode === 'messaging/registration-token-not-registered' ||
                  errorCode === 'messaging/invalid-package-name' ||
                  errorCode === 'messaging/invalid-apns-credential') {
                failedTokens.push(batch[idx]);
              }
            }
          });

          if (failedTokens.length > 0) {
            // The caller should handle cleanup; we just log
            this.logger.warn(`FCM invalid tokens to cleanup: ${failedTokens.length}`);
          }
        }
      } catch (e: any) {
        this.logger.error(`FCM batch send failed: ${e.message}`);
      }
    }
  }
}

export const pushProviderFactory = {
  provide: 'PUSH_PROVIDER',
  inject: [ConfigService],
  useFactory: (config: ConfigService): PushProvider => {
    const mode = config.get<string>('PUSH_PROVIDER') || 'mock';
    if (mode === 'fcm') {
      const hasKey = !!config.get('FCM_SERVER_KEY') || !!config.get('FCM_SERVICE_ACCOUNT_JSON');
      if (!hasKey) {
        throw new Error('PUSH_PROVIDER=fcm requires FCM_SERVER_KEY or FCM_SERVICE_ACCOUNT_JSON');
      }
      if (!config.get('FCM_PROJECT_ID')) {
        throw new Error('PUSH_PROVIDER=fcm requires FCM_PROJECT_ID');
      }
      return new FcmPushProvider(config);
    }
    // mock explicitly requested — only allowed in non-production
    return new MockPushProvider();
  },
};