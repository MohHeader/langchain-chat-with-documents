import { z } from "zod";
import { PDFLoader } from "langchain/document_loaders/fs/pdf";
import { DocxLoader } from "langchain/document_loaders/fs/docx";
import { TextLoader } from "langchain/document_loaders/fs/text";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { WeaviateStore } from "langchain/vectorstores/weaviate";
import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import weaviate from "weaviate-ts-client";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { getObjectAsBlob, transformDoc } from "~/utils/storage";
import { TRPCError } from "@trpc/server";
import { env } from "~/env.mjs";

export const wvClient = weaviate.client({
  scheme: "https",
  host: env.WEAVIATE_HOST,
  apiKey: new weaviate.ApiKey(env.WEAVIATE_API_KEY),
});

const embeddings = new OpenAIEmbeddings({ openAIApiKey: env.OPENAI_API_KEY });

export const weaviateRouter = createTRPCRouter({
  index: publicProcedure
    .input(
      z.object({
        userId: z.string(),
        name: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const { name, userId } = input;
      const Bucket = `doc-${userId}`;
      const Key = name;
      try {
        const { blob, contentType } = await getObjectAsBlob(Bucket, Key);

        let Loader;

        switch (contentType) {
          case "application/pdf":
            Loader = PDFLoader;
            break;
          case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
            Loader = DocxLoader;
            break;
          case "application/msword":
            Loader = DocxLoader;
            break;
          case "text/plain":
            Loader = TextLoader;
            break;
          case "text/csv":
            Loader = TextLoader;
            break;
          default:
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Unsupported file type",
            });
        }

        const loader = new Loader(blob);
        const rawDocs = await loader.load();
        let docs = rawDocs;
        switch (contentType){
          case "text/plain":
            const textSplitter = new RecursiveCharacterTextSplitter();
            docs = await textSplitter.splitDocuments(rawDocs);
            break;
          case "text/csv":
            const csvSplitter = new RecursiveCharacterTextSplitter({
              separators: ["\n",","],
              chunkSize: 10000,
              chunkOverlap: 1,
            });
            docs = await csvSplitter.splitDocuments(rawDocs);
            break;
          default:
            break;
        }
        
        const formattedDocs = docs.map((doc) => transformDoc(doc, { userId, name }));

        await WeaviateStore.fromDocuments(formattedDocs, embeddings, {
          client: wvClient,
          indexName: "Documents",
          metadataKeys: ["userId", "name"],
        });
      } catch (e) {
        console.error(e);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to index document",
        });
      }
    }),
});
