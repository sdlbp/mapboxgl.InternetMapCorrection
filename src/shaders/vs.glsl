// 着色器程序参考：https://github.com/xiaoiver/custom-mapbox-layer/blob/master/src/shaders/project.glsl
uniform mat4 u_matrix;
attribute vec2 a_pos;
attribute vec2 a_TextCoord;
varying vec2 v_TextCoord;
const float TILE_SIZE = 512.0;
const float PI = 3.1415926536;
const float WORLD_SCALE = TILE_SIZE / (PI * 2.0);
uniform float u_project_scale;
uniform bool u_is_offset;
uniform vec3 u_pixels_per_degree;
uniform vec3 u_pixels_per_degree2;
uniform vec3 u_pixels_per_meter;
uniform vec2 u_viewport_center;
uniform vec4 u_viewport_center_projection;

float project_scale(float meters) {
    return meters * u_pixels_per_meter.z;
}

vec3 project_scale(vec3 position) {
    return position * u_pixels_per_meter;
}

vec2 project_mercator(vec2 lnglat) {
    float x = lnglat.x;
    return vec2(
    radians(x) + PI,
    PI - log(tan(PI * 0.25 + radians(lnglat.y) * 0.5))
    );
}

vec4 project_offset(vec4 offset) {
    float dy = offset.y;
    dy = clamp(dy, -1., 1.);
    vec3 pixels_per_unit = u_pixels_per_degree + u_pixels_per_degree2 * dy;
    return vec4(offset.xyz * pixels_per_unit, offset.w);
}

vec4 project_position(vec4 position) {
    if (u_is_offset) {
        float X = position.x - u_viewport_center.x;
        float Y = position.y - u_viewport_center.y;
        return project_offset(vec4(X, Y, position.z, position.w));
    } else {
        return vec4(
        project_mercator(position.xy) * WORLD_SCALE * u_project_scale,
        project_scale(position.z),
        position.w
        );
    }
}

void main() {
    vec4 project_pos = project_position(vec4(a_pos, 0.0, 1.0));
    gl_Position = u_matrix * project_pos + u_viewport_center_projection;
    v_TextCoord = a_TextCoord;
}
