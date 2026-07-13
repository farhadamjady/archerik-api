import { Global, Module } from '@nestjs/common';
import { GraphLookupService } from './graph-lookup.service';

@Global()
@Module({
  providers: [GraphLookupService],
  exports: [GraphLookupService],
})
export class CommonModule {}
