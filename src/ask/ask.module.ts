import { Module } from '@nestjs/common';
import { AskController } from './ask.controller';
import { AskService } from './ask.service';

@Module({
  controllers: [AskController],
  providers: [AskService],
})
export class AskModule {}
