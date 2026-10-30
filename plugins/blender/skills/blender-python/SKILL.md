---
name: blender-python
description: Scripting Blender with bpy through blender_run and blender_info - scene edits, materials, cameras, lights, renders and exports.
---

# Scripting Blender with bpy

Use `blender_info` first to see what a .blend file holds (scenes, objects, materials). Then do the work with `blender_run`, which runs a Python script in `blender --background`. There is no window and no undo, so:

- Work on a copy, or save to a new file, unless the user asked to change the original.
- Nothing is kept unless the script saves: `bpy.ops.wm.save_mainfile()` writes back to the opened file, `bpy.ops.wm.save_as_mainfile(filepath=...)` writes a new one.
- Print what you changed. The printed output is all you get back.
- Use absolute paths, or build them with `bpy.path.abspath("//renders/out.png")` (`//` is the .blend file's folder).

## Basics

```python
import bpy

scene = bpy.context.scene
obj = bpy.data.objects["Cube"]          # KeyError if missing; use .get("Cube") to check
obj.location = (0, 0, 1)
obj.rotation_euler = (0, 0, 0.785)      # radians
obj.scale = (2, 2, 2)
```

- Prefer `bpy.data` over `bpy.ops`. Operators depend on the selection, the active object and the editor context, which barely exist in background mode.
- Create meshes with `bpy.ops.mesh.primitive_*_add(...)` (they work in background mode) or build them from data with `bpy.data.meshes.new` + `mesh.from_pydata(verts, edges, faces)`.
- Link new objects into a collection: `scene.collection.objects.link(obj)`.
- Delete: `bpy.data.objects.remove(obj, do_unlink=True)`.
- Object types: `MESH`, `CAMERA`, `LIGHT`, `EMPTY`, `CURVE`, `ARMATURE`, `GPENCIL`.

## Materials (node based)

```python
mat = bpy.data.materials.new("Red")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.8, 0.1, 0.1, 1)
bsdf.inputs["Roughness"].default_value = 0.4
obj.data.materials.clear()
obj.data.materials.append(mat)
```

Input names changed in Blender 4.0 (for example `Specular` became `Specular IOR Level`, `Emission` became `Emission Color`). Check the version with `bpy.app.version` before using names that differ.

## Camera and lights

```python
cam_data = bpy.data.cameras.new("Cam")
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
cam.location = (7, -7, 5)
cam.rotation_euler = (1.1, 0, 0.785)
scene.camera = cam

light = bpy.data.objects.new("Key", bpy.data.lights.new("Key", type="AREA"))
light.data.energy = 1000
light.location = (4, -4, 6)
scene.collection.objects.link(light)
```

To aim at a target, add a `TRACK_TO` constraint: `c = cam.constraints.new("TRACK_TO"); c.target = obj`.

## Rendering

```python
r = scene.render
r.engine = "BLENDER_EEVEE_NEXT"   # 4.2+; "BLENDER_EEVEE" before, or "CYCLES"
r.resolution_x, r.resolution_y = 1280, 720
r.filepath = "/abs/path/render.png"
r.image_settings.file_format = "PNG"
bpy.ops.render.render(write_still=True)
```

- Cycles on a CPU is slow. For previews lower `scene.cycles.samples` (32 to 64) and the resolution, and raise `timeout_sec` for final renders.
- Animation: set `scene.frame_start` / `frame_end`, a filepath ending in a prefix (`/abs/frames/f_`), then `bpy.ops.render.render(animation=True)`.
- blender_run lists the files Blender reports as saved.

## Import and export

- glTF: `bpy.ops.export_scene.gltf(filepath="/abs/out.glb")`, `bpy.ops.import_scene.gltf(filepath=...)`
- FBX: `bpy.ops.export_scene.fbx(filepath=...)`
- OBJ (3.3+): `bpy.ops.wm.obj_export(filepath=...)`, `bpy.ops.wm.obj_import(filepath=...)`
- STL (4.1+): `bpy.ops.wm.stl_export(filepath=...)`

## When a script fails

blender_run makes Python errors end Blender with exit code 1 and returns the traceback. Common causes:

- `KeyError: 'bpy_prop_collection[key]: key "X" not found'`: the name differs; list names with blender_info.
- `RuntimeError: Operator bpy.ops.X.poll() failed, context is incorrect`: the operator needs an editor or a selection. Use `bpy.data` instead, or wrap it in `with bpy.context.temp_override(...)`.
- An attribute error after an upgrade: the API changed between versions; check `bpy.app.version`.
