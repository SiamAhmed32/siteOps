import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
  // Every error leaves through the platform envelope; nothing internal leaks.
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableCors({ origin: true, credentials: true });
  await app.listen(process.env.PORT ?? 3100);
}
bootstrap();
