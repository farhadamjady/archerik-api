/*
  Warnings:

  - Changed the type of `hosts` on the `identity_map_entries` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "identity_map_entries" DROP COLUMN "hosts",
ADD COLUMN     "hosts" JSONB NOT NULL;
