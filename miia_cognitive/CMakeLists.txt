cmake_minimum_required(VERSION 3.20)
project(miia_cognitive VERSION 2.0 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(hiredis       CONFIG REQUIRED)
find_package(redis++       CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(spdlog        CONFIG REQUIRED)

set(SCRIPTS_DIR "${CMAKE_SOURCE_DIR}/../scripts")
file(MAKE_DIRECTORY "${SCRIPTS_DIR}")

function(add_miia name)
    add_executable(${name} ${name}.cpp)
    target_include_directories(${name} PRIVATE ${CMAKE_SOURCE_DIR})
    target_link_libraries(${name} PRIVATE
        hiredis::hiredis redis++::redis++_static
        nlohmann_json::nlohmann_json spdlog::spdlog)
    add_custom_command(TARGET ${name} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:${name}>" "${SCRIPTS_DIR}/$<TARGET_FILE_NAME:${name}>"
        COMMENT "✅ ${name} → scripts/")
endfunction()

add_miia(class21)
add_miia(class22)
add_miia(class23)
add_miia(class24)
add_miia(class27)
add_miia(class28)
add_miia(class29)
add_miia(class25A)

message(STATUS "miia_cognitive v2.0 — 8 módulos listos")
