import fs from 'node:fs'
import { MISSING, blendPath, findBlender } from '../lib/blender.mjs'
import { clip, failure, run } from '../lib/exec.mjs'

const MARK = '@@BLENDER_INFO@@'

// Runs inside Blender. Reads only; scripts stored in the file stay off (--disable-autoexec).
const PY = `
import bpy, json
def vec(v): return [round(x, 4) for x in v]
scenes = []
for s in bpy.data.scenes:
    r = s.render
    scenes.append({
        "name": s.name,
        "engine": r.engine,
        "resolution": [r.resolution_x, r.resolution_y, r.resolution_percentage],
        "frames": [s.frame_start, s.frame_end],
        "fps": r.fps,
        "camera": s.camera.name if s.camera else None,
        "output": r.filepath,
        "objects": len(s.objects),
    })
objects = []
for o in bpy.data.objects:
    objects.append({
        "name": o.name,
        "type": o.type,
        "data": o.data.name if o.data else None,
        "parent": o.parent.name if o.parent else None,
        "location": vec(o.location),
        "rotation": vec(o.rotation_euler),
        "scale": vec(o.scale),
        "materials": [m.material.name for m in o.material_slots if m.material],
        "collections": [c.name for c in o.users_collection],
    })
info = {
    "version": bpy.app.version_string,
    "file": bpy.data.filepath or None,
    "scenes": scenes,
    "objects": objects,
    "materials": [m.name for m in bpy.data.materials],
    "collections": [c.name for c in bpy.data.collections],
    "images": [i.filepath or i.name for i in bpy.data.images],
}
print("${MARK}" + json.dumps(info))
`

export default {
  name: 'blender_info',
  description:
    'Read a .blend file without changing it: Blender version, scenes (render engine, resolution, frame range, camera, output path), ' +
    'objects (type, transform, materials, collections), materials, collections and images. Without `file` it reports the Blender version and default scene.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'The .blend file to read, relative to the project folder.' },
    },
  },
  kind: 'read',
  readOnly: true,
  subject: (input) => input?.file || 'Blender version',
  async execute(input, ctx) {
    const blend = blendPath(input?.file, ctx.cwd)
    if (blend.error) return { content: blend.error, isError: true }
    if (blend.path && !fs.existsSync(blend.path)) return { content: `File not found: ${blend.path}`, isError: true }
    const bin = findBlender()
    if (!bin) return { content: `Blender was not found. ${MISSING}`, isError: true }
    const args = ['--background', '--factory-startup', '--disable-autoexec', ...(blend.path ? [blend.path] : []), '--python-exit-code', '1', '--python-expr', PY]
    const r = await run(bin, args, { cwd: ctx.cwd, timeoutMs: 120_000, signal: ctx.signal })
    const failed = failure(r, 'Blender', MISSING)
    if (failed) return failed
    const line = r.stdout.split('\n').find((l) => l.startsWith(MARK))
    if (!line) return { content: `Blender didn't report the file's contents (exit code ${r.code}).\n\n${clip(r.out.trim())}`, isError: true }
    try {
      return { content: clip(JSON.stringify(JSON.parse(line.slice(MARK.length))), ctx.toolOutputMaxChars || 30_000) }
    } catch {
      return { content: clip(line.slice(MARK.length)) }
    }
  },
}
