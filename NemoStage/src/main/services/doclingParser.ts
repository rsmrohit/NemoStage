import { spawn } from 'child_process'
import fs from 'fs-extra'
import path from 'path'
import { app } from 'electron'
import type { DoclingManifest, ExtractionProgressEvent } from '../types'

export function runDoclingParser(
pptxPath: string, outputPath: string, onProgress?: (event: ExtractionProgressEvent) => void, emitLog?: (message: string) => void): Promise<DoclingManifest> {
  return new Promise((resolve, reject) => {
    onProgress?.({ phase: 'parsing_structure', progress: 0.05, message: 'Starting Docling parser' })

    const appRoot = app.getAppPath()
    const doclingBinary = path.join(appRoot, '.tmp_docling', 'bin', 'docling')
    const absolutePptxPath = path.resolve(pptxPath)
    
    // Docling creates output file as: <pptx-filename>.json in the cwd
    const pptxBasename = path.basename(absolutePptxPath, '.pptx')
    const doclingOutputFile = path.join(appRoot, `${pptxBasename}.json`)
    
    console.log('[doclingParser] Binary:', doclingBinary)
    console.log('[doclingParser] Input:', absolutePptxPath)
    console.log('[doclingParser] Expected Docling output:', doclingOutputFile)
    console.log('[doclingParser] Final output path:', outputPath)

    const parserProcess = spawn(doclingBinary, ['--to', 'json', absolutePptxPath], {
      cwd: appRoot,
      env: process.env
    })

    let stderrOutput = ''

    parserProcess.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString()
      stderrOutput += chunk
      console.log('[doclingParser] stderr:', chunk)
      onProgress?.({
        phase: 'parsing_structure',
        progress: 0.6,
        message: 'Docling parsing in progress'
      })
    })

    parserProcess.on('close', async (code) => {
      console.log('[doclingParser] Process closed with code:', code)
      
      if (code !== 0) {
        reject(new Error(`Docling failed with exit code ${code}\nStderr: ${stderrOutput}`))
        return
      }

      try {
        // Wait a moment for file to be fully written
        await new Promise(resolve => setTimeout(resolve, 100))
        
        // Check if Docling created the output file
        if (!(await fs.pathExists(doclingOutputFile))) {
          reject(new Error(`Docling didn't create expected output file: ${doclingOutputFile}`))
          return
        }

        console.log('[doclingParser] Reading Docling output from:', doclingOutputFile)
        
        // Read the JSON file Docling created
        const manifest = await fs.readJson(doclingOutputFile) as DoclingManifest
        
        // Copy to the final output location (manifest.json in session dir)
        await fs.writeJson(outputPath, manifest, { spaces: 2 })
        
        // Clean up the Docling-generated file
        await fs.remove(doclingOutputFile)
        
        console.log('[doclingParser] Successfully saved manifest to:', outputPath)
        
        onProgress?.({
          phase: 'parsing_structure',
          progress: 1,
          message: 'Docling parsing complete'
        })
        
        resolve(manifest)
      } catch (error) {
        reject(new Error(`Failed to process Docling output: ${(error as Error).message}`))
      }
    })
  })
}